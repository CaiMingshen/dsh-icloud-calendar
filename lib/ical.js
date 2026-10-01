/**
 * iCalendar semantics: turning server objects into occurrences, and turning a
 * request into a complete VCALENDAR ready to PUT.
 *
 * Two rules shape this module:
 * 1. Recurring events are expanded on the client, because the caller asked for
 *    occurrences in a window and not for a rule it would have to interpret. The
 *    expansion is bounded per series so one hostile or careless `RRULE` cannot
 *    turn a one-day query into years of iteration.
 * 2. Timestamps without an offset are refused. `2026-01-05T09:00:00` means
 *    different instants on different machines, and silently picking the host's
 *    zone is the kind of bug that puts a meeting at the wrong hour.
 */
import ICAL from 'ical.js';
import { CalendarError } from './errors.js';
/** Hard bound on occurrences expanded from one recurring series. */
export const MAX_OCCURRENCES_PER_SERIES = 400;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2})?(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})$/;
/**
 * Parses one caller-supplied timestamp.
 *
 * Accepts `YYYY-MM-DD` (all-day) and RFC3339 with an explicit offset. Anything
 * else is refused, including a local timestamp without an offset.
 */
export function parseInstant(value, field) {
    const trimmed = value.trim();
    if (DATE_ONLY.test(trimmed)) {
        const date = new Date(`${trimmed}T00:00:00Z`);
        if (Number.isNaN(date.getTime())) {
            throw new CalendarError('CALENDAR_INVALID_INPUT', `${field}: "${value}" is not a valid date.`);
        }
        return { kind: 'date', date, input: trimmed };
    }
    if (RFC3339.test(trimmed)) {
        const date = new Date(trimmed);
        if (Number.isNaN(date.getTime())) {
            throw new CalendarError('CALENDAR_INVALID_INPUT', `${field}: "${value}" is not a valid RFC3339 timestamp.`);
        }
        return { kind: 'date-time', date, input: trimmed };
    }
    throw new CalendarError('CALENDAR_INVALID_INPUT', `${field}: use YYYY-MM-DD for an all-day value or an RFC3339 timestamp with an explicit offset ` +
        `(for example 2026-01-05T09:00:00+08:00 or 2026-01-05T01:00:00Z); "${value}" has no usable offset.`);
}
/** Validates a window, capping its span. Both bounds are required. */
export function resolveWindow(start, end, maxWindowMs) {
    const from = parseInstant(start, 'start');
    const to = parseInstant(end, 'end');
    if (to.date.getTime() <= from.date.getTime()) {
        throw new CalendarError('CALENDAR_INVALID_INPUT', `end (${end}) must be after start (${start}).`);
    }
    const span = to.date.getTime() - from.date.getTime();
    if (span > maxWindowMs) {
        const days = Math.round(maxWindowMs / 86_400_000);
        throw new CalendarError('CALENDAR_INVALID_INPUT', `The window is ${Math.round(span / 86_400_000)} days long; the configured maximum is ${days} days. Query in smaller steps.`);
    }
    return { start: from.date, end: to.date, startIso: start, endIso: end };
}
function propertyText(component, name) {
    const value = component.getFirstPropertyValue(name);
    if (value === null || value === undefined)
        return undefined;
    const text = String(value);
    return text === '' ? undefined : text;
}
function registerTimezones(component) {
    for (const vtimezone of component.getAllSubcomponents('vtimezone')) {
        try {
            const timezone = new ICAL.Timezone(vtimezone);
            if (!ICAL.TimezoneService.has(timezone.tzid))
                ICAL.TimezoneService.register(vtimezone);
        }
        catch {
            // A malformed VTIMEZONE must not fail the whole object; the occurrence
            // then falls back to floating time, which the caller can still read.
        }
    }
}
function tzidOf(component, name) {
    const property = component.getFirstProperty(name);
    const tzid = property?.getParameter('tzid');
    return typeof tzid === 'string' && tzid !== '' ? tzid : undefined;
}
/**
 * `YYYY-MM-DD` read from a date-only value's own calendar fields.
 *
 * Reading the day through a JS `Date` instead shifts the date whenever the host
 * zone is west of UTC — the off-by-one-day bug this helper exists to avoid.
 */
function dateOnlyIso(value) {
    return `${String(value.year).padStart(4, '0')}-${pad(value.month)}-${pad(value.day)}`;
}
/** `YYYYMMDD`, the compact form an outgoing DATE-valued property requires. */
function dateOnlyIcs(date) {
    return date.toISOString().slice(0, 10).replace(/-/g, '');
}
/** UTC midnight of a date-only value, used only to order it against a window. */
function dateOnlyBoundary(value) {
    return Date.UTC(value.year, value.month - 1, value.day);
}
function occurrenceEvents(master, series, window, input, limit) {
    const events = [];
    const windowStart = window.start.getTime();
    const windowEnd = window.end.getTime();
    const uid = propertyText(master, 'uid') ?? input.url;
    const summary = propertyText(master, 'summary') ?? '(no title)';
    const location = propertyText(master, 'location');
    const description = propertyText(master, 'description');
    const status = propertyText(master, 'status');
    const allDay = series.startDate?.isDate === true;
    const timeZone = allDay ? undefined : tzidOf(master, 'dtstart');
    const push = (startDate, endDate, recurrenceId) => {
        if (allDay) {
            let end = endDate;
            if (end.compare(startDate) <= 0) {
                end = startDate.clone();
                end.day += 1;
            }
            const startBoundary = dateOnlyBoundary(startDate);
            const endBoundary = dateOnlyBoundary(end);
            if (endBoundary <= windowStart || startBoundary >= windowEnd)
                return;
            events.push({
                uid,
                calendar: input.calendar,
                summary,
                start: dateOnlyIso(startDate),
                end: dateOnlyIso(end),
                allDay: true,
                status,
                recurring: series.isRecurring(),
                url: input.url,
                ...(input.etag === undefined ? {} : { etag: input.etag }),
                ...(location === undefined ? {} : { location }),
                ...(description === undefined ? {} : { description }),
                ...(recurrenceId === undefined ? {} : { recurrenceId }),
            });
            return;
        }
        const startMs = startDate.toJSDate().getTime();
        const endMs = endDate.toJSDate().getTime();
        if (endMs <= windowStart || startMs >= windowEnd)
            return;
        events.push({
            uid,
            calendar: input.calendar,
            summary,
            start: new Date(startMs).toISOString(),
            end: new Date(endMs).toISOString(),
            allDay: false,
            recurring: series.isRecurring(),
            url: input.url,
            ...(timeZone === undefined ? {} : { timeZone }),
            ...(input.etag === undefined ? {} : { etag: input.etag }),
            ...(location === undefined ? {} : { location }),
            ...(description === undefined ? {} : { description }),
            ...(status === undefined ? {} : { status }),
            ...(recurrenceId === undefined ? {} : { recurrenceId }),
        });
    };
    if (!series.isRecurring()) {
        push(series.startDate, series.endDate);
        return { events, truncated: false };
    }
    const iterator = series.iterator();
    let produced = 0;
    let truncated = false;
    for (;;) {
        const occurrence = iterator.next();
        if (occurrence === null)
            break;
        const occurrenceMs = occurrence.toJSDate().getTime();
        if (occurrenceMs >= windowEnd)
            break;
        if (produced >= limit) {
            truncated = true;
            break;
        }
        produced += 1;
        const details = series.getOccurrenceDetails(occurrence);
        if (String(details.item.component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED')
            continue;
        const recurrenceId = details.recurrenceId?.toString();
        push(details.startDate, details.endDate, recurrenceId === undefined ? undefined : recurrenceId);
    }
    return { events, truncated, ...(truncated ? { truncatedUid: uid } : {}) };
}
/**
 * Expands one calendar object into the occurrences that overlap `window`.
 *
 * Recurrence overrides (`RECURRENCE-ID`) are related to their series first, so
 * a moved or renamed instance replaces the rule-generated one.
 */
export function parseCalendarObject(input, window, limit = MAX_OCCURRENCES_PER_SERIES) {
    let component;
    try {
        component = new ICAL.Component(ICAL.parse(input.data));
    }
    catch (error) {
        throw new CalendarError('CALENDAR_UNAVAILABLE', `Could not parse ${input.url}: ${error.message}`);
    }
    registerTimezones(component);
    const vevents = component.getAllSubcomponents('vevent');
    if (vevents.length === 0)
        return { events: [], truncated: false };
    const masterComponent = vevents.find((candidate) => candidate.getFirstProperty('recurrence-id') === null);
    if (masterComponent === undefined) {
        // Only detached instances arrived: treat each as its own single event.
        const events = [];
        for (const vevent of vevents) {
            const single = new ICAL.Event(vevent);
            events.push(...occurrenceEvents(vevent, single, window, input, limit).events);
        }
        return { events, truncated: false };
    }
    const master = new ICAL.Event(masterComponent);
    for (const vevent of vevents) {
        if (vevent === masterComponent)
            continue;
        if (vevent.getFirstProperty('recurrence-id') === null)
            continue;
        try {
            master.relateException(new ICAL.Event(vevent));
        }
        catch {
            // An override that cannot be related is ignored rather than failing the read.
        }
    }
    return occurrenceEvents(masterComponent, master, window, input, limit);
}
/** Expands many objects, concatenating their occurrences. */
export function parseCalendarObjects(inputs, window, limit = MAX_OCCURRENCES_PER_SERIES) {
    const events = [];
    const truncatedSeries = [];
    for (const input of inputs) {
        const result = parseCalendarObject(input, window, limit);
        events.push(...result.events);
        // Name the series that was actually cut short. Deriving it from `events`
        // would report whichever object happened to be parsed first whenever the
        // truncated series contributed no occurrence inside the window.
        if (result.truncated)
            truncatedSeries.push(result.truncatedUid ?? input.url);
    }
    return { events, truncatedSeries };
}
/** Orders occurrences by start instant, then by title for determinism. */
export function sortEvents(events) {
    return [...events].sort((left, right) => {
        const byStart = left.start.localeCompare(right.start);
        if (byStart !== 0)
            return byStart;
        const bySummary = left.summary.localeCompare(right.summary);
        if (bySummary !== 0)
            return bySummary;
        return left.url.localeCompare(right.url);
    });
}
/** Escapes one iCalendar TEXT value. */
export function escapeText(value) {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r?\n/g, '\\n');
}
/** Folds a content line at 75 octets, continuing with a single space. */
export function foldLine(line) {
    const bytes = Buffer.from(line, 'utf8');
    if (bytes.length <= 75)
        return line;
    const parts = [];
    let index = 0;
    let first = true;
    while (index < bytes.length) {
        const width = first ? 75 : 74;
        let end = Math.min(index + width, bytes.length);
        // Do not split a multi-byte character: back off to a character boundary.
        while (end > index && end < bytes.length && (bytes[end] !== undefined && (bytes[end] & 0xc0) === 0x80))
            end -= 1;
        parts.push((first ? '' : ' ') + bytes.subarray(index, end).toString('utf8'));
        index = end;
        first = false;
    }
    return parts.join('\r\n');
}
function pad(value, width = 2) {
    return String(value).padStart(width, '0');
}
/** Formats an instant as a UTC iCalendar timestamp. */
export function formatUtc(date) {
    return (`${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
        `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`);
}
/**
 * Formats an instant as wall-clock time in an IANA zone, which is what a
 * `TZID`-qualified property must carry.
 */
export function formatInZone(date, timeZone) {
    let parts;
    try {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        }).formatToParts(date);
    }
    catch (error) {
        throw new CalendarError('CALENDAR_INVALID_INPUT', `Unknown time zone "${timeZone}": ${error.message}`);
    }
    const lookup = (type) => parts.find((part) => part.type === type)?.value ?? '00';
    return (`${lookup('year')}${lookup('month')}${lookup('day')}` +
        `T${lookup('hour')}${lookup('minute')}${lookup('second')}`);
}
/**
 * Builds a complete VCALENDAR holding one VEVENT.
 *
 * The caller has already validated that `start` and `end` agree on their shape:
 * two dates for an all-day event, two offset-bearing instants otherwise.
 */
export function buildEventIcs(input) {
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//dsh-icloud-calendar//EN',
        'CALSCALE:GREGORIAN',
        'BEGIN:VEVENT',
        `UID:${escapeText(input.uid)}`,
        `DTSTAMP:${formatUtc(input.stamp)}`,
        `SUMMARY:${escapeText(input.summary)}`,
    ];
    if (input.allDay) {
        lines.push(`DTSTART;VALUE=DATE:${dateOnlyIcs(input.start.date)}`);
        lines.push(`DTEND;VALUE=DATE:${dateOnlyIcs(input.end.date)}`);
    }
    else if (input.timeZone !== undefined) {
        lines.push(`DTSTART;TZID=${input.timeZone}:${formatInZone(input.start.date, input.timeZone)}`);
        lines.push(`DTEND;TZID=${input.timeZone}:${formatInZone(input.end.date, input.timeZone)}`);
    }
    else {
        lines.push(`DTSTART:${formatUtc(input.start.date)}`);
        lines.push(`DTEND:${formatUtc(input.end.date)}`);
    }
    if (input.location !== undefined && input.location !== '')
        lines.push(`LOCATION:${escapeText(input.location)}`);
    if (input.description !== undefined && input.description !== '') {
        lines.push(`DESCRIPTION:${escapeText(input.description)}`);
    }
    if (input.sequence !== undefined)
        lines.push(`SEQUENCE:${input.sequence}`);
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return lines.map(foldLine).join('\r\n') + '\r\n';
}
