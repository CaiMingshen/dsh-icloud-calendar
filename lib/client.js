/**
 * The CalDAV client: discovery, calendar listing, range queries, and the three
 * mutating verbs.
 *
 * Choices worth knowing about:
 * - One client instance keeps one credential pair and one discovered home URL,
 *   and reuses TCP connections through the global fetch agent. The measured
 *   cost of a fresh CalDAV handshake is seconds, so a long-lived client is the
 *   difference between a responsive tool and a visibly slow one.
 * - Every request carries a deadline and a small retry budget. Retries are
 *   limited to transport failures, 429 and 5xx; a 401 is never retried, because
 *   repeating a rejected password only risks a lockout.
 * - Writes are guarded by ETags when the server published one: `If-None-Match: *`
 *   on create, `If-Match` on delete. A 412 therefore means "someone else
 *   changed this", not "silently overwrite".
 * - The XML the client reads is extracted by `xml.ts`, a namespace-tolerant
 *   reader for exactly these multistatus replies.
 */
import { randomUUID } from 'node:crypto';
import { CalendarError, errorForStatus, isCalendarError, toCalendarError } from './errors.js';
import { MAX_OCCURRENCES_PER_SERIES, buildEventIcs, parseCalendarObjects, parseInstant, resolveWindow, sortEvents, } from './ical.js';
import { DAV_BODIES, allTags, firstTag, hasTag, parseMultistatus, resolveHref, tagRaw, tagText } from './xml.js';
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
/** True when this thrown value is a cancellation rather than a failure. */
function isAbort(value) {
    return value instanceof Error && (value.name === 'AbortError' || value.name === 'TimeoutError');
}
/** Minimal CalDAV client for iCloud Calendar. */
export class ICloudCalendarClient {
    credentials;
    timeoutMs;
    retries;
    proxyUrl;
    maxOccurrences;
    fetchImpl;
    userAgent;
    home;
    listing;
    dispatcherPromise;
    constructor(options) {
        this.credentials = options.credentials;
        this.timeoutMs = options.timeoutMs ?? 30_000;
        this.retries = Math.max(0, options.retries ?? 2);
        this.proxyUrl = options.proxyUrl ?? '';
        this.maxOccurrences = options.maxOccurrencesPerSeries ?? MAX_OCCURRENCES_PER_SERIES;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
        this.userAgent = options.userAgent ?? 'dsh-icloud-calendar/0.1.0';
    }
    /**
     * Connects and discovers the account's calendar home.
     *
     * Discovery is two PROPFINDs (principal, then home) that cost one round trip
     * each; the calendar listing itself happens lazily on first use.
     */
    static async connect(options, signal) {
        const client = new ICloudCalendarClient(options);
        await client.discover(signal);
        return client;
    }
    /** The server this client talks to, for diagnostics. */
    get serverUrl() {
        return this.credentials.serverUrl;
    }
    /** The account this client authenticates as. */
    get account() {
        return this.credentials.account;
    }
    /** The discovered calendar home URL, when discovery has run. */
    get calendarHome() {
        return this.home;
    }
    authHeader() {
        const raw = `${this.credentials.account}:${this.credentials.secret}`;
        return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
    }
    async dispatcher() {
        if (this.proxyUrl === '')
            return undefined;
        if (this.dispatcherPromise === undefined) {
            this.dispatcherPromise = (async () => {
                try {
                    const undici = (await import('undici'));
                    return new undici.ProxyAgent(this.proxyUrl);
                }
                catch {
                    throw new CalendarError('CALENDAR_INVALID_INPUT', 'proxyUrl is set but the optional "undici" package is not installed. Install it (pnpm add undici) or clear proxyUrl.');
                }
            })();
        }
        return await this.dispatcherPromise;
    }
    async sleep(ms, signal) {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timer);
                reject(signal?.reason instanceof Error ? signal.reason : new Error('cancelled'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }
    /**
     * Performs one request with a deadline and a bounded retry budget.
     *
     * `expect` lists statuses the caller treats as success; anything else raises a
     * coded {@link CalendarError}.
     */
    async request(method, url, options) {
        const expect = options.expect ?? [];
        const dispatcher = await this.dispatcher();
        let attempt = 0;
        for (;;) {
            const controller = new AbortController();
            const onCallerAbort = () => controller.abort(options.signal?.reason);
            options.signal?.addEventListener('abort', onCallerAbort, { once: true });
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                controller.abort(new Error('deadline exceeded'));
            }, this.timeoutMs);
            try {
                if (options.signal?.aborted === true)
                    throw new CalendarError('CALENDAR_NETWORK', `${options.context}: cancelled.`);
                const headers = {
                    authorization: this.authHeader(),
                    'user-agent': this.userAgent,
                    ...options.headers,
                };
                // XML is only the DEFAULT body type. A caller that sends iCalendar (the
                // PUT in createEvent) sets its own content-type, and overwriting it made
                // iCloud answer 501 Not Implemented because it received an .ics payload
                // labelled application/xml.
                if (options.body !== undefined && headers['content-type'] === undefined) {
                    headers['content-type'] = 'application/xml; charset=utf-8';
                }
                if (options.depth !== undefined)
                    headers['depth'] = options.depth;
                const init = { method, headers, signal: controller.signal, redirect: 'follow' };
                if (options.body !== undefined)
                    init.body = options.body;
                if (dispatcher !== undefined)
                    init.dispatcher = dispatcher;
                const response = await this.fetchImpl(url, init);
                if (response.ok || expect.includes(response.status))
                    return response;
                if (RETRYABLE_STATUS.has(response.status) && attempt < this.retries) {
                    const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
                    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(500 * 2 ** attempt, 8000);
                    attempt += 1;
                    await this.sleep(delay, options.signal);
                    continue;
                }
                throw errorForStatus(response.status, options.context);
            }
            catch (error) {
                if (isCalendarError(error))
                    throw error;
                const retryable = !timedOut && !isAbort(error) && attempt < this.retries;
                if (retryable) {
                    attempt += 1;
                    await this.sleep(Math.min(500 * 2 ** attempt, 8000), options.signal);
                    continue;
                }
                if (timedOut) {
                    throw new CalendarError('CALENDAR_TIMEOUT', `${options.context}: no reply within ${this.timeoutMs} ms. Raise timeoutMs, check the network or proxy, or retry.`);
                }
                throw toCalendarError(error, `${options.context}: request failed`);
            }
            finally {
                clearTimeout(timer);
                options.signal?.removeEventListener('abort', onCallerAbort);
            }
        }
    }
    /** Resolves the account principal and its calendar home. */
    async discover(signal) {
        const principalResponse = await this.request('PROPFIND', this.credentials.serverUrl, {
            body: DAV_BODIES.currentUserPrincipal,
            depth: '0',
            expect: [207],
            signal,
            context: 'Discovery (current-user-principal)',
        });
        const principalXml = await principalResponse.text();
        // The property wraps its own <href>, so read the nested element first and
        // fall back to a bare href for servers that flatten the reply.
        const principal = resolveHref(nestedHref(principalXml, 'current-user-principal') ?? tagText(principalXml, 'href') ?? this.credentials.serverUrl, this.credentials.serverUrl);
        const homeResponse = await this.request('PROPFIND', principal, {
            body: DAV_BODIES.calendarHome,
            depth: '0',
            expect: [207],
            signal,
            context: 'Discovery (calendar-home-set)',
        });
        const homeXml = await homeResponse.text();
        const homeHref = nestedHref(homeXml, 'calendar-home-set') ?? tagText(homeXml, 'href');
        this.home = homeHref === undefined ? principal : resolveHref(homeHref, principal);
    }
    /** Reads the calendar collections under the discovered home. */
    async fetchCalendars(signal) {
        const home = this.home;
        if (home === undefined) {
            throw new CalendarError('CALENDAR_UNAVAILABLE', 'The client is not connected: call connect() first.');
        }
        const response = await this.request('PROPFIND', home, {
            body: DAV_BODIES.calendars,
            depth: '1',
            expect: [207],
            signal,
            context: 'Listing calendars',
        });
        const xml = await response.text();
        const calendars = [];
        for (const entry of parseMultistatus(xml)) {
            if (entry.props === '' || !hasTag(entry.props, 'calendar'))
                continue;
            if (hasTag(entry.props, 'resourcetype') && /\<([A-Za-z0-9_.-]+:)?schedule/.test(entry.props))
                continue;
            const url = resolveHref(entry.href, home);
            const name = tagText(entry.props, 'displayname')?.trim();
            const components = allTags(entry.props, 'comp')
                .map((comp) => /name="([^"]+)"/i.exec(comp.attributes)?.[1]?.toUpperCase())
                .filter((value) => value !== undefined);
            const privilegeSet = tagRaw(entry.props, 'current-user-privilege-set');
            const readOnly = privilegeSet === undefined ? false : !(hasTag(privilegeSet, 'write') || hasTag(privilegeSet, 'write-content'));
            const color = tagText(entry.props, 'calendar-color') ?? tagText(entry.props, 'color');
            const timezoneText = tagRaw(entry.props, 'calendar-timezone');
            const tzid = timezoneText === undefined ? undefined : /TZID:([^\r\n;]+)/.exec(timezoneText)?.[1];
            const supportsEvents = components.length === 0 || components.includes('VEVENT');
            calendars.push({
                id: url,
                url,
                name: name === undefined || name === '' ? decodeURIComponent(url.replace(/\/$/, '').split('/').pop() ?? url) : name,
                components,
                supportsEvents,
                readOnly,
                ...(color === undefined ? {} : { color }),
                ...(tzid === undefined ? {} : { timeZone: tzid }),
            });
        }
        return calendars;
    }
    /**
     * Returns the calendar listing, refreshing it when the cached copy is older
     * than `cacheTtlMs`.
     */
    async listCalendars(options = {}) {
        const ttl = options.cacheTtlMs ?? 5 * 60 * 1000;
        const cached = this.listing;
        if (cached !== undefined && options.force !== true) {
            const age = Date.now() - (this.listingAt ?? 0);
            if (age < ttl)
                return cached;
        }
        const fresh = await this.fetchCalendars(options.signal);
        this.listing = fresh;
        this.listingAt = Date.now();
        return fresh;
    }
    listingAt = 0;
    /**
     * Resolves a calendar by name or URL.
     *
     * A missing target is only acceptable when exactly one calendar qualifies;
     * otherwise the caller must name one, and the error lists the candidates.
     */
    resolveCalendar(calendars, target, options = {}) {
        const requireEvents = options.requireEvents ?? true;
        const eligible = calendars.filter((calendar) => {
            if (!requireEvents)
                return true;
            if (!calendar.supportsEvents)
                return false;
            return true;
        });
        if (eligible.length === 0) {
            throw new CalendarError('CALENDAR_NOT_FOUND', calendars.length === 0
                ? 'This account exposes no calendar collections.'
                : `No calendar accepts events. The account has: ${calendars.map((calendar) => calendar.name).join(', ')}.`);
        }
        if (target === undefined || target.trim() === '') {
            if (eligible.length === 1)
                return eligible[0];
            throw new CalendarError('CALENDAR_AMBIGUOUS_TARGET', `Name a calendar explicitly; this account has ${eligible.length}: ${eligible.map((calendar) => calendar.name).join(', ')}.`);
        }
        const wanted = target.trim();
        const byUrl = eligible.find((calendar) => calendar.url === wanted || calendar.id === wanted);
        if (byUrl !== undefined)
            return byUrl;
        const exact = eligible.filter((calendar) => calendar.name === wanted);
        if (exact.length === 1)
            return exact[0];
        if (exact.length > 1) {
            throw new CalendarError('CALENDAR_AMBIGUOUS_TARGET', `More than one calendar is named "${wanted}"; use its collection URL instead.`);
        }
        const insensitive = eligible.filter((calendar) => calendar.name.toLowerCase() === wanted.toLowerCase());
        if (insensitive.length === 1)
            return insensitive[0];
        const candidates = eligible.map((calendar) => calendar.name).join(', ');
        const reminders = calendars.find((calendar) => calendar.name === wanted && !calendar.supportsEvents);
        if (reminders !== undefined) {
            throw new CalendarError('CALENDAR_NOT_FOUND', `"${wanted}" is not a calendar that stores events (it is an iCloud Reminders list). Event calendars: ${candidates}.`);
        }
        throw new CalendarError('CALENDAR_NOT_FOUND', `No calendar named "${wanted}". Available: ${candidates}.`);
    }
    /** Runs one calendar-query and returns the raw objects it carried. */
    async queryObjects(calendar, window, signal) {
        const start = `${window.start.toISOString().replace(/[-:]|\.\d{3}/g, '')}`;
        const end = `${window.end.toISOString().replace(/[-:]|\.\d{3}/g, '')}`;
        const response = await this.request('REPORT', calendar.url, {
            body: DAV_BODIES.calendarQuery(start, end),
            depth: '1',
            expect: [207],
            signal,
            context: `Reading ${calendar.name}`,
        });
        const xml = await response.text();
        const objects = [];
        for (const entry of parseMultistatus(xml)) {
            const data = tagRaw(entry.props, 'calendar-data');
            if (data === undefined || data.trim() === '')
                continue;
            const etag = tagText(entry.props, 'getetag');
            const url = resolveHref(entry.href, calendar.url);
            objects.push({ url, data: unescapeCalendarData(data), ...(etag === undefined ? {} : { etag }) });
        }
        return objects;
    }
    /** Reads and expands the occurrences inside a window, calendar by calendar. */
    async listEvents(window, options = {}) {
        const calendars = [...(options.calendars ?? (await this.listCalendars({ signal: options.signal })))];
        const events = [];
        const truncatedSeries = [];
        const used = [];
        // Serial on purpose: iCloud rate-limits CalDAV, and a burst of parallel
        // reports is the fastest way to get throttled.
        for (const calendar of calendars) {
            if (!calendar.supportsEvents)
                continue;
            options.onProgress?.(`Reading ${calendar.name}`);
            const objects = await this.queryObjects(calendar, window, options.signal);
            const inputs = objects.map((object) => ({
                url: object.url,
                data: object.data,
                calendar: { id: calendar.id, name: calendar.name },
                ...(object.etag === undefined ? {} : { etag: object.etag }),
            }));
            const parsed = parseCalendarObjects(inputs, window, this.maxOccurrences);
            events.push(...parsed.events);
            truncatedSeries.push(...parsed.truncatedSeries);
            used.push({ id: calendar.id, name: calendar.name });
        }
        const sorted = sortEvents(events);
        const limit = options.limit === undefined || options.limit <= 0 ? sorted.length : options.limit;
        return {
            window: { start: window.startIso, end: window.endIso },
            calendars: used,
            events: sorted.slice(0, limit),
            total: sorted.length,
            truncatedSeries,
        };
    }
    /** Reads one specific object by URL, for a mutation that needs freshness. */
    async readObject(url, signal) {
        const response = await this.request('GET', url, { expect: [200], signal, context: 'Reading an event' });
        const data = await response.text();
        const etag = response.headers.get('etag');
        return { url, data, ...(etag === null ? {} : { etag }) };
    }
    /** Creates one event and returns the object the server acknowledged. */
    async createEvent(calendar, request, signal) {
        const start = parseInstant(request.start, 'start');
        const end = parseInstant(request.end, 'end');
        if (start.kind !== end.kind) {
            throw new CalendarError('CALENDAR_INVALID_INPUT', 'start and end must agree: two dates for an all-day event, or two offset-bearing timestamps for a timed event.');
        }
        if (end.date.getTime() <= start.date.getTime()) {
            throw new CalendarError('CALENDAR_INVALID_INPUT', `end (${request.end}) must be after start (${request.start}).`);
        }
        const uid = request.uid ?? `${randomUUID()}@dsh-icloud-calendar`;
        const ics = buildEventIcs({
            uid,
            summary: request.summary,
            start,
            end,
            allDay: start.kind === 'date',
            stamp: new Date(),
            ...(request.location === undefined ? {} : { location: request.location }),
            ...(request.description === undefined ? {} : { description: request.description }),
            ...(start.kind === 'date' || request.timeZone === undefined ? {} : { timeZone: request.timeZone }),
        });
        const url = `${calendar.url.replace(/\/$/, '')}/${encodeURIComponent(uid)}.ics`;
        const response = await this.request('PUT', url, {
            body: ics,
            headers: { 'if-none-match': '*', 'content-type': 'text/calendar; charset=utf-8' },
            expect: [201, 204],
            signal,
            context: `Creating "${request.summary}"`,
        });
        const etag = response.headers.get('etag');
        return {
            uid,
            url,
            calendar: { id: calendar.id, name: calendar.name },
            summary: request.summary,
            start: start.kind === 'date' ? start.input : start.date.toISOString(),
            end: end.kind === 'date' ? end.input : end.date.toISOString(),
            allDay: start.kind === 'date',
            ...(etag === null ? {} : { etag }),
        };
    }
    /** Deletes one object, refusing to race a concurrent modification. */
    async deleteObject(url, etag, signal) {
        await this.request('DELETE', url, {
            expect: [200, 202, 204],
            ...(etag === undefined ? {} : { headers: { 'if-match': etag } }),
            signal,
            context: 'Deleting an event',
        });
    }
}
/**
 * Reads the `<href>` nested inside a property element, which is how both
 * `current-user-principal` and `calendar-home-set` carry their value.
 */
function nestedHref(xml, propertyName) {
    const block = firstTag(xml, propertyName);
    if (block === undefined)
        return undefined;
    return tagText(block.inner, 'href');
}
/**
 * `calendar-data` arrives with XML entities escaped, and some servers wrap it in
 * CDATA. Undo both so the iCalendar parser sees real line breaks.
 */
function unescapeCalendarData(value) {
    const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value);
    if (cdata !== null && cdata[1] !== undefined)
        return cdata[1];
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#13;/g, '\r')
        .replace(/&amp;/g, '&');
}
/** Re-exported so callers can validate windows without importing `ical.ts`. */
export { resolveWindow };
