/**
 * The model-facing tools.
 *
 * Registration only: each tool declares the schema the model sees and delegates
 * to `ctx.icloudCalendar`. Argument types, defaults and bounds live in the
 * service, because a schema cannot express "a window no longer than the profile
 * allows" or "a confirm count that must equal what actually matched".
 *
 * Every tool forwards `exec.signal`, so a cancelled call aborts the in-flight
 * CalDAV request instead of leaving it to finish.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'icloud-calendar-tools';
/** Both the tool registry and the calendar service this row needs. */
export const inject = ['tools', 'icloudCalendar'];
/** Canonical output: lossless JSON rendered as text for the model. */
const output = {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
};
/** Converts a service result into the lossless JSON value the output declares. */
const json = (value) => JSON.parse(JSON.stringify(value));
export function apply(ctx) {
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'calendar_status',
        description: 'Report whether iCloud calendar access is configured, where the password came from, and whether a connection has succeeded. ' +
            'Call this first when another calendar tool reports a configuration or authentication problem, and after storing or changing credentials. ' +
            'It never returns the app-specific password: it reports only which source holds one.',
        parameters: {},
        output,
        execute: async () => json(await ctx.icloudCalendar.status()),
    })));
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'calendar_list_calendars',
        description: 'List the iCloud calendars this account exposes, with each collection URL, display name, colour, time zone and component types. ' +
            'Use the returned name or URL as the "calendars" argument of calendar_list_events or the "calendar" argument of ' +
            'calendar_create_event. iCloud Reminders lists appear here with supportsEvents=false and cannot hold events.',
        parameters: {
            refresh: {
                type: 'boolean',
                description: 'Set true to bypass the listing cache and ask iCloud again, for example right after creating a calendar elsewhere.',
            },
        },
        output,
        timeoutMs: 45_000,
        execute: async (args, exec) => json(await ctx.icloudCalendar.listCalendars({ force: args.refresh === true, signal: exec.signal })),
    })));
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'calendar_list_events',
        description: 'List event occurrences inside a time window. Both bounds are required and the window is capped by the profile. ' +
            'Recurring events are expanded into one entry per occurrence, so a weekly meeting appears once per week; occurrences cancelled ' +
            'individually are omitted. Timed events report UTC instants plus the event\'s own IANA zone in "timeZone"; all-day events report ' +
            'date-only values with allDay=true and an exclusive "end". Pass the returned uid to calendar_delete_events rather than a title.',
        parameters: {
            start: {
                type: 'string',
                required: true,
                description: 'Inclusive window start: an RFC3339 timestamp with an explicit offset (2026-01-05T00:00:00+08:00) or a date (2026-01-05).',
            },
            end: {
                type: 'string',
                required: true,
                description: 'Exclusive window end in the same notation as start, and after it.',
            },
            calendars: {
                type: 'array',
                items: { type: 'string' },
                description: 'Calendar names or collection URLs to read. Omit to read every event calendar the profile allows.',
            },
            limit: {
                type: 'integer',
                description: 'Maximum occurrences to return. The result still reports "total", the full match count before the limit.',
            },
        },
        output,
        timeoutMs: 120_000,
        execute: async (args, exec) => json(await ctx.icloudCalendar.listEvents({
            start: args.start,
            end: args.end,
            ...(args.calendars === undefined ? {} : { calendars: args.calendars }),
            ...(args.limit === undefined ? {} : { limit: args.limit }),
        }, exec.signal)),
    })));
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'calendar_create_event',
        description: 'Create one event in an iCloud calendar. The notation of start and end states the intent: two dates (2026-01-05) create an ' +
            'all-day event whose end is exclusive, while two RFC3339 timestamps with an explicit offset create a timed event. A timestamp ' +
            'without an offset is refused, because it would silently mean a different instant in each time zone. Name the calendar when more ' +
            'than one event calendar exists, otherwise the target is ambiguous and the call fails.',
        parameters: {
            summary: { type: 'string', required: true, description: 'Event title, for example "Design review".' },
            start: { type: 'string', required: true, description: '2026-01-05T09:00:00+08:00 for a timed event, or 2026-01-05 for an all-day event.' },
            end: {
                type: 'string',
                required: true,
                description: 'End in the same notation as start. For an all-day event this is exclusive: one day is start=2026-01-05, end=2026-01-06.',
            },
            calendar: { type: 'string', description: 'Target calendar name or collection URL; required when several qualify.' },
            location: { type: 'string', description: 'Optional free-text location.' },
            description: { type: 'string', description: 'Optional longer notes.' },
            timeZone: {
                type: 'string',
                description: 'Optional IANA zone (Asia/Shanghai) for a timed event, so the event carries a zone instead of a bare UTC instant.',
            },
        },
        output,
        timeoutMs: 60_000,
        execute: async (args, exec) => json(await ctx.icloudCalendar.createEvent({
            summary: args.summary,
            start: args.start,
            end: args.end,
            ...(args.calendar === undefined ? {} : { calendar: args.calendar }),
            ...(args.location === undefined ? {} : { location: args.location }),
            ...(args.description === undefined ? {} : { description: args.description }),
            ...(args.timeZone === undefined ? {} : { timeZone: args.timeZone }),
        }, exec.signal)),
    })));
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'calendar_delete_events',
        description: 'Delete events, behind four gates. First, deletes must be enabled in the profile. Second, the window (start and end) is mandatory ' +
            'and shorter than a read window. Third, the target must be named exactly: "uid" from calendar_list_events, or "summaryEquals" with ' +
            'the complete title — partial matches are refused. Fourth, this call defaults to dryRun=true and only reports what matched; a real ' +
            'delete needs dryRun=false plus "confirmCount" equal to the reported object count, and one call may not exceed the configured cap. ' +
            'Deleting an occurrence deletes its whole recurring series.',
        parameters: {
            start: { type: 'string', required: true, description: 'Inclusive window start, for example 2026-01-01T00:00:00+08:00.' },
            end: { type: 'string', required: true, description: 'Exclusive window end.' },
            uid: { type: 'string', description: 'Event uid or object URL, copied from calendar_list_events. Prefer this over a title.' },
            summaryEquals: {
                type: 'string',
                description: 'Complete, exact event title (case-sensitive, no wildcards). Only used when uid is absent.',
            },
            calendar: { type: 'string', description: 'Restrict the scan to one calendar name or collection URL.' },
            dryRun: {
                type: 'boolean',
                description: 'Defaults to true: report the match without deleting. Set false only after reviewing a dry run.',
            },
            confirmCount: {
                type: 'integer',
                description: 'Required when dryRun is false: must equal the number of objects the dry run reported.',
            },
            maxDeletes: { type: 'integer', description: 'Lower the per-call cap for this call; it can never raise the configured cap.' },
        },
        output,
        timeoutMs: 120_000,
        execute: async (args, exec) => json(await ctx.icloudCalendar.deleteEvents({
            start: args.start,
            end: args.end,
            ...(args.uid === undefined ? {} : { uid: args.uid }),
            ...(args.summaryEquals === undefined ? {} : { summaryEquals: args.summaryEquals }),
            ...(args.calendar === undefined ? {} : { calendar: args.calendar }),
            ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
            ...(args.confirmCount === undefined ? {} : { confirmCount: args.confirmCount }),
            ...(args.maxDeletes === undefined ? {} : { maxDeletes: args.maxDeletes }),
        }, exec.signal)),
    })));
}
