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
import { type SecureStore, type SecureStoreDescription, type SecureStoreSelector } from './credentials.js';
import type { Credentials } from './types.js';
/** Where the account name may come from, in order. */
export declare const ACCOUNT_ENV = "ICLOUD_ACCOUNT";
/** Where the app-specific password may come from, when the profile does not say. */
export declare const DEFAULT_SECRET_ENV = "ICLOUD_APP_PASSWORD";
/** Selection policy when both an environment variable and the store hold a secret. */
export type SecretSourcePolicy = 'auto' | 'env' | 'store';
/** Effective plugin configuration. */
export interface Config {
    /** Apple ID email address; falls back to the `ICLOUD_ACCOUNT` variable. */
    account: string;
    /** Environment variable holding the app-specific password. */
    secretEnv: string;
    /** Which secret source wins when both are populated; validated on use. */
    secretSource: string;
    /** CalDAV entry point. iCloud's is the default. */
    serverUrl: string;
    /** Per-request deadline in milliseconds. */
    timeoutMs: number;
    /** Retries after the first attempt, for transient failures only. */
    retries: number;
    /** Optional HTTP proxy for both discovery and requests. */
    proxyUrl: string;
    /** Calendars every read includes; empty means all event calendars. */
    defaultCalendars: string[];
    /** How long a calendar listing stays cached, in milliseconds. */
    cacheTtlMs: number;
    /** Master switch for create/update writes. */
    allowWrites: boolean;
    /** Master switch for deletes. Off by default. */
    allowDeletes: boolean;
    /** Upper bound on objects one delete call may remove. */
    maxDeletesPerCall: number;
    /** Longest window a read may request, in days. */
    maxWindowDays: number;
    /** Longest window a delete scan may request, in days. */
    maxDeleteWindowDays: number;
    /** Credential backend; `auto` uses the platform store. Validated on use. */
    storeKind: string;
    /** Directory for the DPAPI blob on Windows. */
    storeDirectory: string;
    /** Occurrences expanded per recurring series before the read gives up. */
    maxOccurrencesPerSeries: number;
}
/**
 * Defaults in one place.
 *
 * The schema below reads its defaults from this object, so a profile that omits
 * a field and the standalone CLI agree by construction instead of by review.
 */
export declare const DEFAULT_CONFIG: Config;
/**
 * Cordis validates a row's `config` against this schema before the plugin
 * activates, so {@link Config} is both the type above and the runtime validator.
 *
 * No field is marked `volatile`: an operator changes these values by editing the
 * profile, which remounts the plugin and is the behavior this plugin documents.
 */
export declare const Config: Schema<Config>;
/** Merges caller overrides onto {@link DEFAULT_CONFIG} for non-Cordis callers. */
export declare function resolveConfig(overrides?: Partial<Config>): Config;
/** Resolved secret, plus where it came from — never the value's text. */
export interface ResolvedSecret {
    secret: string;
    source: 'env' | 'store';
}
/** Non-secret description used by `calendar_status` and the CLI. */
export interface ConfigurationDescription {
    account: string | null;
    serverUrl: string;
    secretEnvVar: string;
    secretSourcePolicy: SecretSourcePolicy;
    store: SecureStoreDescription;
    writesAllowed: boolean;
    deletesAllowed: boolean;
    timeoutMs: number;
    retries: number;
    proxyConfigured: boolean;
    maxWindowDays: number;
    maxDeleteWindowDays: number;
    maxDeletesPerCall: number;
}
/** Narrows a configured policy string, refusing anything unrecognized. */
export declare function assertPolicy(value: string): SecretSourcePolicy;
/** Narrows a configured store kind, refusing anything unrecognized. */
export declare function assertStoreKind(value: string): SecureStoreSelector;
/**
 * Validates the server URL: HTTPS (or plain HTTP on loopback), no embedded
 * credentials, no query or fragment.
 *
 * The loopback exception exists for self-hosted CalDAV servers — Radicale,
 * Nextcloud or Baikal on the same machine — which are commonly served over
 * plain HTTP and are not reachable from anywhere else. Credentials still travel
 * in an Authorization header, so a remote host must be HTTPS.
 */
export declare function assertServerUrl(value: string): string;
/** Builds the store the configuration selects, honoring the environment override. */
export declare function storeFor(config: Config, env?: NodeJS.ProcessEnv): SecureStore;
/** Resolves the account name, or explains both places it looked. */
export declare function resolveAccount(config: Config, env?: NodeJS.ProcessEnv): string;
/**
 * Reads the app-specific password.
 *
 * `auto` prefers the OS credential store and falls back to the environment, on
 * the assumption that a secret deliberately stored on this machine is fresher
 * than one inherited from a shell profile. Set `secretSource` to pin either side.
 */
export declare function resolveSecret(config: Config, account: string, store: SecureStore, env?: NodeJS.ProcessEnv): Promise<ResolvedSecret>;
/** Resolves everything the client needs, plus the provenance for `status`. */
export declare function resolveCredentials(config: Config, store: SecureStore, env?: NodeJS.ProcessEnv): Promise<{
    credentials: Credentials;
    source: ResolvedSecret['source'];
    storeDescription: SecureStoreDescription;
}>;
/** The non-secret half of the configuration, for status reporting. */
export declare function describeConfiguration(config: Config, store: SecureStore, env?: NodeJS.ProcessEnv): ConfigurationDescription;
