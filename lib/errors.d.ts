/**
 * Error vocabulary.
 *
 * Every failure the plugin raises is a {@link CalendarError} carrying a stable
 * code. The tool layer lets these propagate: the registry turns a thrown error
 * into model-readable content, and a code such as `CALENDAR_AUTH_FAILED` tells
 * the model (and the human reading the transcript) which of the several
 * credential mistakes actually happened.
 */
/** Stable failure codes; safe to branch on in callers and tests. */
export type CalendarErrorCode = 'CALENDAR_NOT_CONFIGURED' | 'CALENDAR_AUTH_FAILED' | 'CALENDAR_CREDENTIAL_STORE' | 'CALENDAR_NETWORK' | 'CALENDAR_TIMEOUT' | 'CALENDAR_RATE_LIMITED' | 'CALENDAR_UNAVAILABLE' | 'CALENDAR_NOT_FOUND' | 'CALENDAR_AMBIGUOUS_TARGET' | 'CALENDAR_INVALID_INPUT' | 'CALENDAR_READ_ONLY' | 'CALENDAR_UNSAFE_DELETE' | 'CALENDAR_CONFLICT';
/** One plugin failure with a machine-readable code. */
export declare class CalendarError extends Error {
    readonly code: CalendarErrorCode;
    /** Extra, non-secret context: an HTTP status, a variable name, a path. */
    readonly detail: Record<string, unknown> | undefined;
    constructor(code: CalendarErrorCode, message: string, detail?: Record<string, unknown>);
}
/** Narrows an unknown thrown value to a {@link CalendarError}. */
export declare function isCalendarError(value: unknown): value is CalendarError;
/**
 * Normalizes anything thrown into a {@link CalendarError}, so a caller never has
 * to render a raw `TypeError` from a socket or a parser.
 */
export declare function toCalendarError(value: unknown, fallbackMessage?: string): CalendarError;
/** Maps an HTTP status to the failure a CalDAV caller should report. */
export declare function errorForStatus(status: number, context: string): CalendarError;
