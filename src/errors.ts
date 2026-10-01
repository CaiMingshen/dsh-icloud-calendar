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
export type CalendarErrorCode =
  | 'CALENDAR_NOT_CONFIGURED'
  | 'CALENDAR_AUTH_FAILED'
  | 'CALENDAR_CREDENTIAL_STORE'
  | 'CALENDAR_NETWORK'
  | 'CALENDAR_TIMEOUT'
  | 'CALENDAR_RATE_LIMITED'
  | 'CALENDAR_UNAVAILABLE'
  | 'CALENDAR_NOT_FOUND'
  | 'CALENDAR_AMBIGUOUS_TARGET'
  | 'CALENDAR_INVALID_INPUT'
  | 'CALENDAR_READ_ONLY'
  | 'CALENDAR_UNSAFE_DELETE'
  | 'CALENDAR_CONFLICT'

/** One plugin failure with a machine-readable code. */
export class CalendarError extends Error {
  readonly code: CalendarErrorCode
  /** Extra, non-secret context: an HTTP status, a variable name, a path. */
  readonly detail: Record<string, unknown> | undefined

  constructor(code: CalendarErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'CalendarError'
    this.code = code
    this.detail = detail
  }
}

/** Narrows an unknown thrown value to a {@link CalendarError}. */
export function isCalendarError(value: unknown): value is CalendarError {
  return value instanceof CalendarError
}

/**
 * Normalizes anything thrown into a {@link CalendarError}, so a caller never has
 * to render a raw `TypeError` from a socket or a parser.
 */
export function toCalendarError(value: unknown, fallbackMessage = 'Calendar operation failed'): CalendarError {
  if (isCalendarError(value)) return value
  const message = value instanceof Error ? value.message : String(value)
  return new CalendarError('CALENDAR_NETWORK', message === '' ? fallbackMessage : message)
}

/** Maps an HTTP status to the failure a CalDAV caller should report. */
export function errorForStatus(status: number, context: string): CalendarError {
  if (status === 401 || status === 403) {
    return new CalendarError(
      'CALENDAR_AUTH_FAILED',
      `${context}: iCloud rejected the credentials (HTTP ${status}). Use an app-specific password, not the Apple ID password, and confirm the Apple ID email is the account name.`,
      { status },
    )
  }
  if (status === 404) {
    return new CalendarError('CALENDAR_NOT_FOUND', `${context}: the server has no such resource (HTTP 404).`, { status })
  }
  if (status === 412) {
    return new CalendarError(
      'CALENDAR_CONFLICT',
      `${context}: the event changed on the server since it was read (HTTP 412). Re-read it and retry.`,
      { status },
    )
  }
  if (status === 429) {
    return new CalendarError(
      'CALENDAR_RATE_LIMITED',
      `${context}: iCloud rate-limited the request (HTTP 429). Wait a moment and retry.`,
      { status },
    )
  }
  if (status >= 500) {
    return new CalendarError('CALENDAR_UNAVAILABLE', `${context}: the server failed (HTTP ${status}).`, { status })
  }
  return new CalendarError('CALENDAR_UNAVAILABLE', `${context}: unexpected HTTP ${status}.`, { status })
}
