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
import { resolveWindow } from './ical.js';
import type { CalendarSummary, CreateEventRequest, CreatedEvent, Credentials, EventWindow, ListEventsResult } from './types.js';
/** Construction options; the deadline and retry budget come from the profile. */
export interface ClientOptions {
    credentials: Credentials;
    /** Per-request deadline in milliseconds. */
    timeoutMs?: number;
    /** Retries after the first attempt. */
    retries?: number;
    /** Optional HTTP proxy, honored through the optional `undici` package. */
    proxyUrl?: string;
    /** Occurrence cap applied per recurring series. */
    maxOccurrencesPerSeries?: number;
    /** Injection point for tests. */
    fetchImpl?: typeof fetch;
    userAgent?: string;
}
/** One response block that carried an event object. */
interface ObjectResponse {
    url: string;
    etag?: string;
    data: string;
}
/** Minimal CalDAV client for iCloud Calendar. */
export declare class ICloudCalendarClient {
    private readonly credentials;
    private readonly timeoutMs;
    private readonly retries;
    private readonly proxyUrl;
    private readonly maxOccurrences;
    private readonly fetchImpl;
    private readonly userAgent;
    private home;
    private listing;
    private dispatcherPromise;
    private constructor();
    /**
     * Connects and discovers the account's calendar home.
     *
     * Discovery is two PROPFINDs (principal, then home) that cost one round trip
     * each; the calendar listing itself happens lazily on first use.
     */
    static connect(options: ClientOptions, signal?: AbortSignal): Promise<ICloudCalendarClient>;
    /** The server this client talks to, for diagnostics. */
    get serverUrl(): string;
    /** The account this client authenticates as. */
    get account(): string;
    /** The discovered calendar home URL, when discovery has run. */
    get calendarHome(): string | undefined;
    private authHeader;
    private dispatcher;
    private sleep;
    /**
     * Performs one request with a deadline and a bounded retry budget.
     *
     * `expect` lists statuses the caller treats as success; anything else raises a
     * coded {@link CalendarError}.
     */
    private request;
    /** Resolves the account principal and its calendar home. */
    private discover;
    /** Reads the calendar collections under the discovered home. */
    private fetchCalendars;
    /**
     * Returns the calendar listing, refreshing it when the cached copy is older
     * than `cacheTtlMs`.
     */
    listCalendars(options?: {
        signal?: AbortSignal;
        force?: boolean;
        cacheTtlMs?: number;
    }): Promise<CalendarSummary[]>;
    private listingAt;
    /**
     * Resolves a calendar by name or URL.
     *
     * A missing target is only acceptable when exactly one calendar qualifies;
     * otherwise the caller must name one, and the error lists the candidates.
     */
    resolveCalendar(calendars: readonly CalendarSummary[], target: string | undefined, options?: {
        requireEvents?: boolean;
    }): CalendarSummary;
    /** Runs one calendar-query and returns the raw objects it carried. */
    private queryObjects;
    /** Reads and expands the occurrences inside a window, calendar by calendar. */
    listEvents(window: EventWindow, options?: {
        calendars?: readonly CalendarSummary[];
        signal?: AbortSignal;
        limit?: number;
        onProgress?: (message: string) => void;
    }): Promise<ListEventsResult>;
    /** Reads one specific object by URL, for a mutation that needs freshness. */
    readObject(url: string, signal?: AbortSignal): Promise<ObjectResponse | undefined>;
    /** Creates one event and returns the object the server acknowledged. */
    createEvent(calendar: CalendarSummary, request: CreateEventRequest, signal?: AbortSignal): Promise<CreatedEvent>;
    /** Deletes one object, refusing to race a concurrent modification. */
    deleteObject(url: string, etag: string | undefined, signal?: AbortSignal): Promise<void>;
}
/** Re-exported so callers can validate windows without importing `ical.ts`. */
export { resolveWindow };
