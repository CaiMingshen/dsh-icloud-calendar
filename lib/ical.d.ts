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
import type { CalendarEvent, EventWindow } from './types.js';
/** Hard bound on occurrences expanded from one recurring series. */
export declare const MAX_OCCURRENCES_PER_SERIES = 400;
/** One calendar object as it came off the wire. */
export interface CalendarObjectInput {
    url: string;
    etag?: string;
    /** Raw iCalendar text of the object. */
    data: string;
    calendar: {
        id: string;
        name: string;
    };
}
/** Outcome of expanding one calendar object inside a window. */
export interface ParseResult {
    events: CalendarEvent[];
    /** True when the per-series occurrence bound cut the expansion short. */
    truncated: boolean;
    /** UID of the series that hit the bound, present only when `truncated`. */
    truncatedUid?: string;
}
/** One parsed user-supplied timestamp. */
export interface ParsedInstant {
    /** `date` for an all-day value, `date-time` otherwise. */
    kind: 'date' | 'date-time';
    /** The instant; for `date`, midnight in the host zone. */
    date: Date;
    /** The value as the caller wrote it. */
    input: string;
}
/**
 * Parses one caller-supplied timestamp.
 *
 * Accepts `YYYY-MM-DD` (all-day) and RFC3339 with an explicit offset. Anything
 * else is refused, including a local timestamp without an offset.
 */
export declare function parseInstant(value: string, field: string): ParsedInstant;
/** Validates a window, capping its span. Both bounds are required. */
export declare function resolveWindow(start: string, end: string, maxWindowMs: number): EventWindow;
/**
 * Expands one calendar object into the occurrences that overlap `window`.
 *
 * Recurrence overrides (`RECURRENCE-ID`) are related to their series first, so
 * a moved or renamed instance replaces the rule-generated one.
 */
export declare function parseCalendarObject(input: CalendarObjectInput, window: EventWindow, limit?: number): ParseResult;
/** Expands many objects, concatenating their occurrences. */
export declare function parseCalendarObjects(inputs: readonly CalendarObjectInput[], window: EventWindow, limit?: number): {
    events: CalendarEvent[];
    truncatedSeries: string[];
};
/** Orders occurrences by start instant, then by title for determinism. */
export declare function sortEvents(events: readonly CalendarEvent[]): CalendarEvent[];
/** Escapes one iCalendar TEXT value. */
export declare function escapeText(value: string): string;
/** Folds a content line at 75 octets, continuing with a single space. */
export declare function foldLine(line: string): string;
/** Formats an instant as a UTC iCalendar timestamp. */
export declare function formatUtc(date: Date): string;
/**
 * Formats an instant as wall-clock time in an IANA zone, which is what a
 * `TZID`-qualified property must carry.
 */
export declare function formatInZone(date: Date, timeZone: string): string;
/** Input for {@link buildEventIcs}. */
export interface BuildEventInput {
    uid: string;
    summary: string;
    /** All-day: `YYYY-MM-DD`. Timed: an instant. */
    start: ParsedInstant;
    end: ParsedInstant;
    allDay: boolean;
    location?: string;
    description?: string;
    /** IANA zone for a timed event; without it the event is written in UTC. */
    timeZone?: string;
    stamp: Date;
    sequence?: number;
}
/**
 * Builds a complete VCALENDAR holding one VEVENT.
 *
 * The caller has already validated that `start` and `end` agree on their shape:
 * two dates for an all-day event, two offset-bearing instants otherwise.
 */
export declare function buildEventIcs(input: BuildEventInput): string;
