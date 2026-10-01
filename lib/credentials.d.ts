/**
 * Cross-platform storage for the app-specific password.
 *
 * Design rule: the password is never written to a file this plugin controls in
 * plaintext, and never placed in a command line. Each backend therefore gets
 * the secret through stdin (DPAPI, libsecret) or through the platform tool that
 * owns the secret for us (Keychain, which takes it as an argument and is the one
 * documented exception).
 *
 * Backends:
 * - `dpapi` (Windows): PowerShell `ConvertTo-SecureString` / `ConvertFrom-SecureString`
 *   writes a DPAPI blob bound to the current user. Only that user on that machine
 *   can decrypt it. The blob lives under `%LOCALAPPDATA%\dsh-icloud-calendar`.
 * - `keychain` (macOS): `security add-generic-password` in the login keychain.
 * - `secret-tool` (Linux): libsecret, i.e. GNOME Keyring or KWallet.
 * - `none`: no persistence; the secret must come from the environment.
 */
/** Backends this module can drive. */
export type SecureStoreKind = 'dpapi' | 'keychain' | 'secret-tool' | 'none';
/** `auto` resolves to the backend of the current platform. */
export type SecureStoreSelector = 'auto' | SecureStoreKind;
/** What {@link SecureStore.describe} reports to `calendar_status`. */
export interface SecureStoreDescription {
    kind: SecureStoreKind;
    /** Human-readable location of the secret, or null when nothing is stored. */
    location: string | null;
    /** Whether this backend can be used on the current platform. */
    available: boolean;
}
/** A minimal secret store: one account, one secret. */
export interface SecureStore {
    readonly description: SecureStoreDescription;
    /** Returns the stored secret, or undefined when nothing is stored. */
    get(account: string): Promise<string | undefined>;
    /** Stores or replaces the secret for this account. */
    set(account: string, secret: string): Promise<void>;
    /** Removes the stored secret; false when there was nothing to remove. */
    remove(account: string): Promise<boolean>;
}
/** Service name used by Keychain and libsecret entries. */
export declare const STORE_SERVICE = "dsh-icloud-calendar";
/** Environment variable that overrides the backend selection. */
export declare const STORE_KIND_ENV = "DSH_ICLOUD_CALENDAR_STORE";
/** The backend `auto` selects on this platform. */
export declare function defaultStoreKind(platform?: NodeJS.Platform): SecureStoreKind;
/** Default directory for the DPAPI blob. */
export declare function defaultStoreDirectory(env?: NodeJS.ProcessEnv): string;
/** Builds the store for one selector, defaulting to the platform backend. */
export declare function createSecureStore(selector?: SecureStoreSelector, options?: {
    directory?: string;
}): SecureStore;
