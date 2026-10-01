/**
 * Error vocabulary.
 *
 * Every failure the plugin raises is a {@link CalendarError} carrying a stable
 * code. The tool layer lets these propagate: the registry turns a thrown error
 * into model-readable content, and a code such as `CALENDAR_AUTH_FAILED` tells
 * the model (and the human reading the transcript) which of the several
 * credential mistakes actually happened.
 */
/** One plugin failure with a machine-readable code. */
export class CalendarError extends Error {
    code;
    /** Extra, non-secret context: an HTTP status, a variable name, a path. */
    detail;
    constructor(code, message, detail) {
        super(message);
        this.name = 'CalendarError';
        this.code = code;
        this.detail = detail;
    }
}
/** Narrows an unknown thrown value to a {@link CalendarError}. */
export function isCalendarError(value) {
    return value instanceof CalendarError;
}
/**
 * Normalizes anything thrown into a {@link CalendarError}, so a caller never has
 * to render a raw `TypeError` from a socket or a parser.
 */
export function toCalendarError(value, fallbackMessage = 'Calendar operation failed') {
    if (isCalendarError(value))
        return value;
    const message = value instanceof Error ? value.message : String(value);
    return new CalendarError('CALENDAR_NETWORK', message === '' ? fallbackMessage : message);
}
/** Maps an HTTP status to the failure a CalDAV caller should report. */
export function errorForStatus(status, context) {
    if (status === 401 || status === 403) {
        return new CalendarError('CALENDAR_AUTH_FAILED', `${context}: iCloud rejected the credentials (HTTP ${status}). Use an app-specific password, not the Apple ID password, and confirm the Apple ID email is the account name.`, { status });
    }
    if (status === 404) {
        return new CalendarError('CALENDAR_NOT_FOUND', `${context}: the server has no such resource (HTTP 404).`, { status });
    }
    if (status === 412) {
        return new CalendarError('CALENDAR_CONFLICT', `${context}: the event changed on the server since it was read (HTTP 412). Re-read it and retry.`, { status });
    }
    if (status === 429) {
        return new CalendarError('CALENDAR_RATE_LIMITED', `${context}: iCloud rate-limited the request (HTTP 429). Wait a moment and retry.`, { status });
    }
    if (status >= 500) {
        return new CalendarError('CALENDAR_UNAVAILABLE', `${context}: the server failed (HTTP ${status}).`, { status });
    }
    return new CalendarError('CALENDAR_UNAVAILABLE', `${context}: unexpected HTTP ${status}.`, { status });
}
