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
import { CalendarError } from './errors.js';
import { resolveWindow } from './ical.js';
const DAY_MS = 86_400_000;
/**
 * Runs the guard and, when every gate passes, performs the deletes.
 *
 * A dry run is the default in two senses: `dryRun` must be explicitly false,
 * and even then `confirmCount` must equal the number of matched objects.
 */
export async function runDelete(deps, request, signal) {
    const { config } = deps;
    const notes = [];
    if (!config.allowDeletes) {
        throw new CalendarError('CALENDAR_READ_ONLY', 'Deletes are disabled for this profile (allowDeletes is false). Enable it on the host row before deleting anything.');
    }
    const target = (request.uid ?? '').trim();
    const title = request.summaryEquals ?? '';
    if (target === '' && title === '') {
        throw new CalendarError('CALENDAR_UNSAFE_DELETE', 'A delete must name its target exactly: pass "uid" (preferred, copied from calendar_list_events) or "summaryEquals" ' +
            'with the complete, exact title. Substring and fuzzy matches are refused on purpose.');
    }
    const dryRun = request.dryRun !== false;
    const window = resolveWindow(request.start, request.end, config.maxDeleteWindowDays * DAY_MS);
    const calendars = await deps.selectCalendars(request.calendar === undefined ? undefined : [request.calendar], signal);
    const matched = [];
    const etags = new Map();
    for (const calendar of calendars) {
        const result = await deps.listEvents({ start: request.start, end: request.end, calendars: [calendar.name] }, signal);
        for (const event of result.events) {
            const matchesUid = target !== '' && (event.uid === target || event.url === target);
            const matchesTitle = title !== '' && event.summary === title;
            if (!matchesUid && !matchesTitle)
                continue;
            matched.push({
                uid: event.uid,
                summary: event.summary,
                start: event.start,
                end: event.end,
                calendar: event.calendar,
                url: event.url,
            });
            etags.set(event.url, event.etag);
        }
    }
    const objects = [...new Set(matched.map((event) => event.url))];
    const cap = Math.max(1, Math.min(request.maxDeletes ?? config.maxDeletesPerCall, config.maxDeletesPerCall));
    if (objects.length === 0) {
        return { dryRun, matched: [], deleted: [], count: 0, notes: ['Nothing matched inside the window.'] };
    }
    if (objects.length > cap) {
        throw new CalendarError('CALENDAR_UNSAFE_DELETE', `${objects.length} objects matched but one call may delete at most ${cap}. Narrow the window, name one event by uid, ` +
            'or raise maxDeletesPerCall in the profile.', { matched: objects.length, cap });
    }
    if (matched.length > objects.length) {
        notes.push(`${matched.length} occurrences matched ${objects.length} calendar object(s): deleting removes the whole recurring series.`);
    }
    if (dryRun) {
        notes.push('Dry run: nothing was deleted. Repeat with dryRun=false and confirmCount equal to the object count to proceed.');
        return { dryRun: true, matched, deleted: [], count: objects.length, notes };
    }
    if (request.confirmCount !== objects.length) {
        throw new CalendarError('CALENDAR_UNSAFE_DELETE', `Refusing to delete: confirmCount must equal the number of matched objects (${objects.length}); received ` +
            `${request.confirmCount ?? 'nothing'}. Run the call without dryRun=false first to see exactly what matches.`, { expected: objects.length, received: request.confirmCount ?? null });
    }
    const deleted = [];
    for (const url of objects) {
        await deps.deleteObject(url, etags.get(url), signal);
        deleted.push(url);
    }
    return { dryRun: false, matched, deleted, count: deleted.length, notes };
}
