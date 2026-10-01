/**
 * Public surface of the package.
 *
 * A DSH profile mounts two rows from here (`dsh-icloud-calendar/host` and
 * `dsh-icloud-calendar/tools`); everything else is exported so a consumer can
 * reuse the client, the credential store, or the iCalendar helpers without
 * importing a `lib/` path directly.
 */

export {
  ICloudCalendarService as default,
  ICloudCalendarService,
  Config,
  name,
  type ListEventsOptions,
} from './host.js'

export { ICloudCalendarClient, type ClientOptions } from './client.js'

export {
  Config as CalendarConfig,
  ACCOUNT_ENV,
  DEFAULT_SECRET_ENV,
  assertServerUrl,
  describeConfiguration,
  resolveAccount,
  resolveCredentials,
  resolveSecret,
  storeFor,
  type Config as ConfigShape,
  type ConfigurationDescription,
  type SecretSourcePolicy,
} from './config.js'

export {
  STORE_KIND_ENV,
  STORE_SERVICE,
  createSecureStore,
  defaultStoreDirectory,
  defaultStoreKind,
  type SecureStore,
  type SecureStoreDescription,
  type SecureStoreKind,
  type SecureStoreSelector,
} from './credentials.js'

export { CalendarError, errorForStatus, isCalendarError, toCalendarError, type CalendarErrorCode } from './errors.js'

export {
  MAX_OCCURRENCES_PER_SERIES,
  buildEventIcs,
  parseCalendarObject,
  parseCalendarObjects,
  parseInstant,
  resolveWindow,
  sortEvents,
  type CalendarObjectInput,
  type ParsedInstant,
} from './ical.js'

export { runDelete, type DeleteDeps } from './policy.js'

export type {
  CalendarEvent,
  CalendarStatus,
  CalendarSummary,
  CreateEventRequest,
  CreatedEvent,
  Credentials,
  DeleteEventsRequest,
  DeleteEventsResult,
  EventWindow,
  ListEventsResult,
  MatchedEvent,
} from './types.js'
