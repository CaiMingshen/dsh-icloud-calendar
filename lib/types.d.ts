/**
 * Shared vocabulary for the iCloud calendar plugin.
 *
 * Everything here is plain data: the service returns these shapes, the tools
 * project them to the model, and the CLI prints them. Keeping them in one
 * module is what lets the three callers agree without importing each other.
 */
/** Credentials needed to talk to one CalDAV server. */
export interface Credentials {
    /** Apple ID email address, not a nickname. */
    account: string;
    /** App-specific password. Never logged, never returned by a tool. */
    secret: string;
    /** CalDAV entry point; iCloud's is `https://caldav.icloud.com/`. */
    serverUrl: string;
}
/** One calendar collection discovered on the server. */
export interface CalendarSummary {
    /** Collection URL; also the stable id used in later calls. */
    id: string;
    /** Human-readable display name, for example `Home`. */
    name: string;
    /** Collection URL, same value as {@link id} but named for readability. */
    url: string;
    /**
     * Colour exactly as the server published it. iCloud sends `#RRGGBBAA`
     * (observed on a real account: `#FFCC00FF`), so consumers should not assume
     * six hex digits.
     */
    color?: string;
    /** Default time zone reported by the collection, when present. */
    timeZone?: string;
    /** Component types the collection accepts, for example `VEVENT`, `VTODO`. */
    components: string[];
    /**
     * Whether the collection can store events. A collection that publishes no
     * component set at all counts as usable: iCloud publishes none (observed on a
     * real account — all 19 collections reported an empty set), so treating
     * "unknown" as "no" would skip every calendar the account has.
     */
    supportsEvents: boolean;
    /** Whether the collection is read-only for this account. */
    readOnly: boolean;
}
/** One event occurrence, already expanded for recurring series. */
export interface CalendarEvent {
    /** Series UID, stable across occurrences of one recurring event. */
    uid: string;
    /** Calendar the occurrence was read from. */
    calendar: {
        id: string;
        name: string;
    };
    /** Event title. */
    summary: string;
    /** Start as an ISO-8601 instant with offset, or `YYYY-MM-DD` when all-day. */
    start: string;
    /** Exclusive end in the same format as {@link start}. */
    end: string;
    /** True for date-only events; then {@link end} is exclusive. */
    allDay: boolean;
    /** IANA time zone of the event, when the event declares one. */
    timeZone?: string;
    /** Free-text location. */
    location?: string;
    /** Longer notes. */
    description?: string;
    /** `CONFIRMED`, `TENTATIVE`, `CANCELLED`, or the server's own token. */
    status?: string;
    /** Whether the occurrence belongs to a recurring series. */
    recurring: boolean;
    /** Recurrence id for an overridden occurrence of a series. */
    recurrenceId?: string;
    /** Object URL; the handle used to update or delete exactly this object. */
    url: string;
    /** Object ETag, when the server reports one. */
    etag?: string;
}
/** Validated, half-open time window. */
export interface EventWindow {
    start: Date;
    end: Date;
    /** The requested bounds, echoed back in the caller's own notation. */
    startIso: string;
    endIso: string;
}
/** Result of listing events. */
export interface ListEventsResult {
    window: {
        start: string;
        end: string;
    };
    calendars: Array<{
        id: string;
        name: string;
    }>;
    events: CalendarEvent[];
    /** Matching occurrences before `limit` was applied. */
    total: number;
    /** Series UIDs whose expansion hit the safety bound and was cut short. */
    truncatedSeries: string[];
}
/** Arguments for creating one event. */
export interface CreateEventRequest {
    summary: string;
    /** RFC3339 instant with offset, or `YYYY-MM-DD` for an all-day event. */
    start: string;
    /** Exclusive end in the same notation as {@link start}. */
    end: string;
    /** Calendar name or collection URL; required when more than one qualifies. */
    calendar?: string;
    location?: string;
    description?: string;
    /** Time zone for a timed event whose start carries an offset. */
    timeZone?: string;
    /** Supply a UID to make the write idempotent for retries. */
    uid?: string;
}
/** Result of creating one event. */
export interface CreatedEvent {
    uid: string;
    url: string;
    etag?: string;
    calendar: {
        id: string;
        name: string;
    };
    summary: string;
    start: string;
    end: string;
    allDay: boolean;
}
/** Arguments for the confirm-gated delete. */
export interface DeleteEventsRequest {
    /** Inclusive window start; mandatory. */
    start: string;
    /** Exclusive window end; mandatory. */
    end: string;
    /** Exact object URL, or an event UID. */
    uid?: string;
    /** Exact, case-sensitive title match. Substring matching is refused. */
    summaryEquals?: string;
    /** Calendar name or collection URL to restrict the scan. */
    calendar?: string;
    /** Defaults to true: report what would be deleted without deleting. */
    dryRun?: boolean;
    /** Must equal the number of matched events; the second confirmation. */
    confirmCount?: number;
    /** Cap on events this call may delete; defaults to 1. */
    maxDeletes?: number;
}
/** One matched event in a delete report. */
export interface MatchedEvent {
    uid: string;
    summary: string;
    start: string;
    end: string;
    calendar: {
        id: string;
        name: string;
    };
    url: string;
}
/** Result of a delete call, dry-run or real. */
export interface DeleteEventsResult {
    dryRun: boolean;
    matched: MatchedEvent[];
    /** Object URLs actually deleted; empty on a dry run. */
    deleted: string[];
    count: number;
    notes: string[];
}
/** Readiness snapshot; never contains the secret. */
export interface CalendarStatus {
    configured: boolean;
    account: string | null;
    serverUrl: string;
    /** Where the secret came from: `env`, `config`, `dpapi`, `keychain`, `secret-tool`, or null. */
    secretSource: string | null;
    /** Environment variable the plugin would read when no other source is set. */
    secretEnvVar: string;
    /** Description of the active OS credential store. */
    store: {
        kind: string;
        location: string | null;
        available: boolean;
    };
    timeoutMs: number;
    retries: number;
    proxyConfigured: boolean;
    writesAllowed: boolean;
    deletesAllowed: boolean;
    connected: boolean;
    calendarCount: number | null;
    lastError: {
        code: string;
        message: string;
    } | null;
}
