/**
 * The host service: `ctx.icloudCalendar`.
 *
 * This module owns everything with a lifetime �?the connected client, the
 * calendar cache, the last failure �?and enforces the policy the tools only
 * describe. Mounting this row without the `tools` row keeps the calendar usable
 * from code while remaining invisible to the model.
 *
 * The delete guard lives in `policy.ts` so the service, the CLI and any future
 * caller share one implementation of it.
 */
import { Service } from '@deepseek-ai/cordis';
import { ICloudCalendarClient } from './client.js';
import { Config as ConfigSchema, describeConfiguration, resolveCredentials, storeFor, } from './config.js';
import { CalendarError, isCalendarError, toCalendarError } from './errors.js';
import { resolveWindow } from './ical.js';
import { runDelete } from './policy.js';
export const name = 'icloud-calendar-host';
/** The row's config schema; Cordis validates `config` against it at activation. */
export const Config = ConfigSchema;
const DAY_MS = 86_400_000;
/**
 * iCloud Calendar over CalDAV, as a cordis service.
 *
 * The service holds one client: connecting costs seconds on iCloud, so it is
 * worth keeping. A failed connection is never cached, which means exporting the
 * app-specific password after the harness started is picked up by the next call
 * instead of requiring a restart.
 */
export class ICloudCalendarService extends Service {
    config;
    static Config = ConfigSchema;
    store;
    client;
    connecting;
    lastError = null;
    secretSource = null;
    calendarCount = null;
    constructor(ctx, config) {
        super(ctx, 'icloudCalendar');
        this.config = config;
        this.store = storeFor(config);
    }
    /** The configuration in force, with no secret material in it. */
    get configuration() {
        return describeConfiguration(this.config, this.store);
    }
    /** Connects at most once per healthy client; failures are not remembered. */
    async connect(signal) {
        if (this.client !== undefined)
            return this.client;
        if (this.connecting === undefined) {
            this.connecting = (async () => {
                try {
                    const resolved = await resolveCredentials(this.config, this.store);
                    this.secretSource = resolved.source;
                    const client = await ICloudCalendarClient.connect({
                        credentials: resolved.credentials,
                        timeoutMs: this.config.timeoutMs,
                        retries: this.config.retries,
                        proxyUrl: this.config.proxyUrl,
                        maxOccurrencesPerSeries: this.config.maxOccurrencesPerSeries,
                    }, signal);
                    this.client = client;
                    this.lastError = null;
                    return client;
                }
                catch (error) {
                    const normalized = toCalendarError(error);
                    this.lastError = { code: normalized.code, message: normalized.message };
                    this.client = undefined;
                    throw normalized;
                }
                finally {
                    this.connecting = undefined;
                }
            })();
        }
        return await this.connecting;
    }
    /** Readiness snapshot: what is configured, and what happened last. */
    async status() {
        const description = this.configuration;
        let configured = false;
        if (description.account !== null) {
            try {
                const resolved = await resolveCredentials(this.config, this.store);
                this.secretSource = resolved.source;
                configured = true;
            }
            catch (error) {
                if (!isCalendarError(error) || error.code !== 'CALENDAR_NOT_CONFIGURED')
                    throw error;
                this.secretSource = null;
            }
        }
        return {
            configured,
            account: description.account,
            serverUrl: description.serverUrl,
            secretSource: this.secretSource,
            secretEnvVar: description.secretEnvVar,
            store: description.store,
            timeoutMs: description.timeoutMs,
            retries: description.retries,
            proxyConfigured: description.proxyConfigured,
            writesAllowed: description.writesAllowed,
            deletesAllowed: description.deletesAllowed,
            connected: this.client !== undefined,
            calendarCount: this.calendarCount,
            lastError: this.lastError,
        };
    }
    /** Calendars visible to this account, cached for `cacheTtlMs`. */
    async listCalendars(options = {}) {
        const client = await this.connect(options.signal);
        const calendars = await client.listCalendars({
            force: options.force ?? false,
            cacheTtlMs: this.config.cacheTtlMs,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        this.calendarCount = calendars.length;
        return calendars;
    }
    /** Resolves the calendars a call names, falling back to the profile default. */
    async selectCalendars(requested, signal) {
        const all = await this.listCalendars({ ...(signal === undefined ? {} : { signal }) });
        const client = await this.connect(signal);
        const names = requested !== undefined && requested.length > 0 ? requested : this.config.defaultCalendars;
        if (names.length === 0)
            return all.filter((calendar) => calendar.supportsEvents);
        return names.map((entry) => client.resolveCalendar(all, entry));
    }
    /** Lists event occurrences inside a bounded window. */
    async listEvents(options, signal) {
        const window = resolveWindow(options.start, options.end, this.config.maxWindowDays * DAY_MS);
        const calendars = await this.selectCalendars(options.calendars, signal);
        const client = await this.connect(signal);
        const result = await client.listEvents(window, {
            calendars,
            ...(signal === undefined ? {} : { signal }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        });
        this.calendarCount = result.calendars.length;
        this.lastError = null;
        return result;
    }
    /** Creates one event in an explicitly resolved calendar. */
    async createEvent(request, signal) {
        if (!this.config.allowWrites) {
            throw new CalendarError('CALENDAR_READ_ONLY', 'This profile is read-only for the calendar (allowWrites is false). Set it to true on the host row to create events.');
        }
        const client = await this.connect(signal);
        const all = await this.listCalendars({ ...(signal === undefined ? {} : { signal }) });
        const calendar = client.resolveCalendar(all, request.calendar);
        if (calendar.readOnly) {
            throw new CalendarError('CALENDAR_READ_ONLY', `"${calendar.name}" is read-only for this account; the server published no write privilege for it.`);
        }
        const created = await client.createEvent(calendar, request, signal);
        this.lastError = null;
        return created;
    }
    /** Confirm-gated delete; the gates themselves live in {@link runDelete}. */
    async deleteEvents(request, signal) {
        const result = await runDelete({
            config: this.config,
            selectCalendars: async (requested, inner) => await this.selectCalendars(requested, inner),
            listEvents: async (options, inner) => await this.listEvents(options, inner),
            deleteObject: async (url, etag, inner) => {
                const client = await this.connect(inner);
                await client.deleteObject(url, etag, inner);
            },
        }, request, signal);
        this.lastError = null;
        return result;
    }
}
export default ICloudCalendarService;
