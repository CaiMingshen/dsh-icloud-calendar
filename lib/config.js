/**
 * Plugin configuration and credential resolution.
 *
 * The schema carries no secret field on purpose. A profile patch is a file on
 * disk; putting the app-specific password there would defeat the OS credential
 * store this plugin ships with. The password therefore comes from the
 * environment or from the store, and this module is the only place that decides
 * which.
 */
import Schema from '@deepseek-ai/schemastery';
import { STORE_KIND_ENV, createSecureStore, defaultStoreDirectory, } from './credentials.js';
import { CalendarError } from './errors.js';
/** Where the account name may come from, in order. */
export const ACCOUNT_ENV = 'ICLOUD_ACCOUNT';
/** Where the app-specific password may come from, when the profile does not say. */
export const DEFAULT_SECRET_ENV = 'ICLOUD_APP_PASSWORD';
/**
 * Defaults in one place.
 *
 * The schema below reads its defaults from this object, so a profile that omits
 * a field and the standalone CLI agree by construction instead of by review.
 */
export const DEFAULT_CONFIG = {
    account: '',
    secretEnv: DEFAULT_SECRET_ENV,
    secretSource: 'auto',
    serverUrl: 'https://caldav.icloud.com/',
    timeoutMs: 30_000,
    retries: 2,
    proxyUrl: '',
    defaultCalendars: [],
    cacheTtlMs: 5 * 60 * 1000,
    allowWrites: true,
    // Off by default: a fresh installation cannot delete anything until someone
    // edits the profile on purpose.
    allowDeletes: false,
    maxDeletesPerCall: 1,
    maxWindowDays: 366,
    maxDeleteWindowDays: 90,
    storeKind: 'auto',
    storeDirectory: '',
    maxOccurrencesPerSeries: 400,
};
/**
 * Cordis validates a row's `config` against this schema before the plugin
 * activates, so {@link Config} is both the type above and the runtime validator.
 *
 * No field is marked `volatile`: an operator changes these values by editing the
 * profile, which remounts the plugin and is the behavior this plugin documents.
 */
export const Config = Schema.object({
    account: Schema.string().default(DEFAULT_CONFIG.account),
    secretEnv: Schema.string().default(DEFAULT_CONFIG.secretEnv),
    secretSource: Schema.string().default(DEFAULT_CONFIG.secretSource),
    serverUrl: Schema.string().default(DEFAULT_CONFIG.serverUrl),
    timeoutMs: Schema.number().default(DEFAULT_CONFIG.timeoutMs),
    retries: Schema.number().default(DEFAULT_CONFIG.retries),
    proxyUrl: Schema.string().default(DEFAULT_CONFIG.proxyUrl),
    defaultCalendars: Schema.array(Schema.string()).default([...DEFAULT_CONFIG.defaultCalendars]),
    cacheTtlMs: Schema.number().default(DEFAULT_CONFIG.cacheTtlMs),
    allowWrites: Schema.boolean().default(DEFAULT_CONFIG.allowWrites),
    allowDeletes: Schema.boolean().default(DEFAULT_CONFIG.allowDeletes),
    maxDeletesPerCall: Schema.number().default(DEFAULT_CONFIG.maxDeletesPerCall),
    maxWindowDays: Schema.number().default(DEFAULT_CONFIG.maxWindowDays),
    maxDeleteWindowDays: Schema.number().default(DEFAULT_CONFIG.maxDeleteWindowDays),
    storeKind: Schema.string().default(DEFAULT_CONFIG.storeKind),
    storeDirectory: Schema.string().default(DEFAULT_CONFIG.storeDirectory),
    maxOccurrencesPerSeries: Schema.number().default(DEFAULT_CONFIG.maxOccurrencesPerSeries),
});
/** Merges caller overrides onto {@link DEFAULT_CONFIG} for non-Cordis callers. */
export function resolveConfig(overrides = {}) {
    return { ...DEFAULT_CONFIG, ...overrides };
}
const VALID_POLICIES = ['auto', 'env', 'store'];
const VALID_STORE_KINDS = ['auto', 'dpapi', 'keychain', 'secret-tool', 'none'];
/** Narrows a configured policy string, refusing anything unrecognized. */
export function assertPolicy(value) {
    if (VALID_POLICIES.includes(value))
        return value;
    throw new CalendarError('CALENDAR_INVALID_INPUT', `secretSource must be one of ${VALID_POLICIES.join(', ')}; received "${value}".`);
}
/** Narrows a configured store kind, refusing anything unrecognized. */
export function assertStoreKind(value) {
    if (VALID_STORE_KINDS.includes(value))
        return value;
    throw new CalendarError('CALENDAR_INVALID_INPUT', `storeKind must be one of ${VALID_STORE_KINDS.join(', ')}; received "${value}".`);
}
/**
 * Validates the server URL: HTTPS (or plain HTTP on loopback), no embedded
 * credentials, no query or fragment.
 *
 * The loopback exception exists for self-hosted CalDAV servers — Radicale,
 * Nextcloud or Baikal on the same machine — which are commonly served over
 * plain HTTP and are not reachable from anywhere else. Credentials still travel
 * in an Authorization header, so a remote host must be HTTPS.
 */
export function assertServerUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new CalendarError('CALENDAR_INVALID_INPUT', `serverUrl "${value}" is not a valid URL.`);
    }
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        throw new CalendarError('CALENDAR_INVALID_INPUT', `serverUrl must use HTTPS; plain HTTP is accepted only for a loopback host (127.0.0.1, ::1, localhost). ` +
            `Received "${url.protocol}//${url.hostname}".`);
    }
    if (url.username !== '' || url.password !== '') {
        throw new CalendarError('CALENDAR_INVALID_INPUT', 'serverUrl must not embed an account or a secret.');
    }
    if (url.search !== '' || url.hash !== '') {
        throw new CalendarError('CALENDAR_INVALID_INPUT', 'serverUrl must not carry a query or a fragment.');
    }
    return url.toString();
}
/** Builds the store the configuration selects, honoring the environment override. */
export function storeFor(config, env = process.env) {
    const override = env[STORE_KIND_ENV];
    const kind = override !== undefined && override !== '' ? assertStoreKind(override) : assertStoreKind(config.storeKind);
    const directory = config.storeDirectory !== '' ? config.storeDirectory : defaultStoreDirectory(env);
    return createSecureStore(kind, { directory });
}
/** Resolves the account name, or explains both places it looked. */
export function resolveAccount(config, env = process.env) {
    const fromConfig = config.account.trim();
    if (fromConfig !== '')
        return fromConfig;
    const fromEnv = (env[ACCOUNT_ENV] ?? '').trim();
    if (fromEnv !== '')
        return fromEnv;
    throw new CalendarError('CALENDAR_NOT_CONFIGURED', `No Apple ID is configured. Set the host row's "account", or export ${ACCOUNT_ENV}, for example ` +
        `${ACCOUNT_ENV}="you@example.com".`);
}
/**
 * Reads the app-specific password.
 *
 * `auto` prefers the OS credential store and falls back to the environment, on
 * the assumption that a secret deliberately stored on this machine is fresher
 * than one inherited from a shell profile. Set `secretSource` to pin either side.
 */
export async function resolveSecret(config, account, store, env = process.env) {
    const policy = assertPolicy(config.secretSource);
    const fromEnv = () => {
        const value = env[config.secretEnv];
        return value === undefined || value.trim() === '' ? undefined : { secret: value.trim(), source: 'env' };
    };
    const fromStore = async () => {
        if (!store.description.available)
            return undefined;
        const value = await store.get(account);
        return value === undefined || value === '' ? undefined : { secret: value, source: 'store' };
    };
    if (policy === 'env') {
        const resolved = fromEnv();
        if (resolved !== undefined)
            return resolved;
        throw notConfigured(config, account, `the environment variable ${config.secretEnv} is empty`);
    }
    if (policy === 'store') {
        const resolved = await fromStore();
        if (resolved !== undefined)
            return resolved;
        throw notConfigured(config, account, `the ${store.description.kind} credential store holds no secret for this account`);
    }
    const stored = await fromStore();
    if (stored !== undefined)
        return stored;
    const inherited = fromEnv();
    if (inherited !== undefined)
        return inherited;
    throw notConfigured(config, account, `neither the ${store.description.kind} credential store nor ${config.secretEnv} holds a secret`);
}
function notConfigured(config, account, reason) {
    return new CalendarError('CALENDAR_NOT_CONFIGURED', `No app-specific password is available for ${account}: ${reason}. Create one at https://appleid.apple.com ` +
        `(Sign-In and Security -> App-Specific Passwords), then either export ${config.secretEnv} or store it with ` +
        `"dsh-icloud-calendar login --account ${account}". Do not use the Apple ID password: two-factor authentication makes it fail.`);
}
/** Resolves everything the client needs, plus the provenance for `status`. */
export async function resolveCredentials(config, store, env = process.env) {
    const account = resolveAccount(config, env);
    const resolved = await resolveSecret(config, account, store, env);
    const credentials = {
        account,
        secret: resolved.secret,
        serverUrl: assertServerUrl(config.serverUrl),
    };
    return { credentials, source: resolved.source, storeDescription: store.description };
}
/** The non-secret half of the configuration, for status reporting. */
export function describeConfiguration(config, store, env = process.env) {
    let account = null;
    try {
        account = resolveAccount(config, env);
    }
    catch {
        account = null;
    }
    return {
        account,
        serverUrl: config.serverUrl,
        secretEnvVar: config.secretEnv,
        secretSourcePolicy: assertPolicy(config.secretSource),
        store: store.description,
        writesAllowed: config.allowWrites,
        deletesAllowed: config.allowDeletes,
        timeoutMs: config.timeoutMs,
        retries: config.retries,
        proxyConfigured: config.proxyUrl !== '',
        maxWindowDays: config.maxWindowDays,
        maxDeleteWindowDays: config.maxDeleteWindowDays,
        maxDeletesPerCall: config.maxDeletesPerCall,
    };
}
