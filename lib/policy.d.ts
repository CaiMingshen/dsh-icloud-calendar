/**
 * The delete guard, isolated from the service so exactly one implementation
 * protects every caller: the model-facing tool, the CLI, and any future caller.
 *
 * The rule this encodes comes from a real accident: a `delete` that matched a
 * substring removed eight unrelated events in one call. Every gate below exists
 * to make that impossible:
 *
 * 1. deletes must be enabled in the profile (`allowDeletes`, off by default);
 * 2. the window is mandatory and shorter than the read window;
 * 3. the target is named exactly — a uid, an object URL, or the complete title;
 * 4. the first call is always a dry run unless the caller explicitly says otherwise;
 * 5. a real delete must confirm the exact object count, and that count is capped.
 */
import type { Config } from './config.js';
import type { CalendarSummary, DeleteEventsRequest, DeleteEventsResult, ListEventsResult } from './types.js';
/** Options the guard passes to a read. */
export interface GuardListOptions {
    start: string;
    end: string;
    calendars?: readonly string[];
    limit?: number;
}
/** What the guard needs from whoever owns the connection. */
export interface DeleteDeps {
    config: Config;
    /** Calendars the caller may touch, after name resolution. */
    selectCalendars(requested: readonly string[] | undefined, signal?: AbortSignal): Promise<CalendarSummary[]>;
    /** Occurrence read, used to find the objects a request names. */
    listEvents(options: GuardListOptions, signal?: AbortSignal): Promise<ListEventsResult>;
    /** Removes one object, with an ETag precondition when one is known. */
    deleteObject(url: string, etag: string | undefined, signal?: AbortSignal): Promise<void>;
}
/**
 * Runs the guard and, when every gate passes, performs the deletes.
 *
 * A dry run is the default in two senses: `dryRun` must be explicitly false,
 * and even then `confirmCount` must equal the number of matched objects.
 */
export declare function runDelete(deps: DeleteDeps, request: DeleteEventsRequest, signal?: AbortSignal): Promise<DeleteEventsResult>;
