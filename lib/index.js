/**
 * Public surface of the package.
 *
 * A DSH profile mounts two rows from here (`dsh-icloud-calendar/host` and
 * `dsh-icloud-calendar/tools`); everything else is exported so a consumer can
 * reuse the client, the credential store, or the iCalendar helpers without
 * importing a `lib/` path directly.
 */
export { ICloudCalendarService as default, ICloudCalendarService, Config, name, } from './host.js';
export { ICloudCalendarClient } from './client.js';
export { Config as CalendarConfig, ACCOUNT_ENV, DEFAULT_SECRET_ENV, assertServerUrl, describeConfiguration, resolveAccount, resolveCredentials, resolveSecret, storeFor, } from './config.js';
export { STORE_KIND_ENV, STORE_SERVICE, createSecureStore, defaultStoreDirectory, defaultStoreKind, } from './credentials.js';
export { CalendarError, errorForStatus, isCalendarError, toCalendarError } from './errors.js';
export { MAX_OCCURRENCES_PER_SERIES, buildEventIcs, parseCalendarObject, parseCalendarObjects, parseInstant, resolveWindow, sortEvents, } from './ical.js';
export { runDelete } from './policy.js';
