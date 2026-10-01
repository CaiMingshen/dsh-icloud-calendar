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
import { Service, type Context } from '@deepseek-ai/cordis';
import { Config as ConfigSchema, describeConfiguration, type Config as CalendarConfig } from './config.js';
import type { CalendarStatus, CalendarSummary, CreateEventRequest, CreatedEvent, DeleteEventsRequest, DeleteEventsResult, ListEventsResult } from './types.js';
export declare const name = "icloud-calendar-host";
/** The row's config schema; Cordis validates `config` against it at activation. */
export declare const Config: import("@deepseek-ai/schemastery").default<ConfigSchema>;
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** iCloud calendar access for this profile. */
        icloudCalendar: ICloudCalendarService;
    }
}
/** Options accepted by {@link ICloudCalendarService.listEvents}. */
export interface ListEventsOptions {
    start: string;
    end: string;
    calendars?: readonly string[];
    limit?: number;
    onProgress?: (message: string) => void;
}
/**
 * iCloud Calendar over CalDAV, as a cordis service.
 *
 * The service holds one client: connecting costs seconds on iCloud, so it is
 * worth keeping. A failed connection is never cached, which means exporting the
 * app-specific password after the harness started is picked up by the next call
 * instead of requiring a restart.
 */
export declare class ICloudCalendarService extends Service {
    private readonly config;
    static Config: import("@deepseek-ai/schemastery").default<ConfigSchema>;
    private readonly store;
    private client;
    private connecting;
    private lastError;
    private secretSource;
    private calendarCount;
    constructor(ctx: Context, config: CalendarConfig);
    /** The configuration in force, with no secret material in it. */
    get configuration(): ReturnType<typeof describeConfiguration>;
    /** Connects at most once per healthy client; failures are not remembered. */
    private connect;
    /** Readiness snapshot: what is configured, and what happened last. */
    status(): Promise<CalendarStatus>;
    /** Calendars visible to this account, cached for `cacheTtlMs`. */
    listCalendars(options?: {
        force?: boolean;
        signal?: AbortSignal;
    }): Promise<CalendarSummary[]>;
    /** Resolves the calendars a call names, falling back to the profile default. */
    selectCalendars(requested: readonly string[] | undefined, signal?: AbortSignal): Promise<CalendarSummary[]>;
    /** Lists event occurrences inside a bounded window. */
    listEvents(options: ListEventsOptions, signal?: AbortSignal): Promise<ListEventsResult>;
    /** Creates one event in an explicitly resolved calendar. */
    createEvent(request: CreateEventRequest, signal?: AbortSignal): Promise<CreatedEvent>;
    /** Confirm-gated delete; the gates themselves live in {@link runDelete}. */
    deleteEvents(request: DeleteEventsRequest, signal?: AbortSignal): Promise<DeleteEventsResult>;
}
export default ICloudCalendarService;
