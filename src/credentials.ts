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

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CalendarError } from './errors.js'

/** Backends this module can drive. */
export type SecureStoreKind = 'dpapi' | 'keychain' | 'secret-tool' | 'none'

/** `auto` resolves to the backend of the current platform. */
export type SecureStoreSelector = 'auto' | SecureStoreKind

/** What {@link SecureStore.describe} reports to `calendar_status`. */
export interface SecureStoreDescription {
  kind: SecureStoreKind
  /** Human-readable location of the secret, or null when nothing is stored. */
  location: string | null
  /** Whether this backend can be used on the current platform. */
  available: boolean
}

/** A minimal secret store: one account, one secret. */
export interface SecureStore {
  readonly description: SecureStoreDescription
  /** Returns the stored secret, or undefined when nothing is stored. */
  get(account: string): Promise<string | undefined>
  /** Stores or replaces the secret for this account. */
  set(account: string, secret: string): Promise<void>
  /** Removes the stored secret; false when there was nothing to remove. */
  remove(account: string): Promise<boolean>
}

/** Service name used by Keychain and libsecret entries. */
export const STORE_SERVICE = 'dsh-icloud-calendar'

/** Environment variable that overrides the backend selection. */
export const STORE_KIND_ENV = 'DSH_ICLOUD_CALENDAR_STORE'

/** The backend `auto` selects on this platform. */
export function defaultStoreKind(platform: NodeJS.Platform = process.platform): SecureStoreKind {
  if (platform === 'win32') return 'dpapi'
  if (platform === 'darwin') return 'keychain'
  if (platform === 'linux') return 'secret-tool'
  return 'none'
}

/** Default directory for the DPAPI blob. */
export function defaultStoreDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const base = env['LOCALAPPDATA'] ?? env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  return join(base, STORE_SERVICE)
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

interface RunOptions {
  stdin?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/**
 * Runs one helper process and captures its streams.
 *
 * The secret travels through `stdin` or the inherited environment only; it is
 * never interpolated into the argument vector, because a process's argv is
 * readable by other processes of the same user.
 */
async function run(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return await new Promise<RunResult>((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        timeout: options.timeoutMs ?? 20_000,
        env: { ...process.env, ...options.env },
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1
        if (error !== null && code === 0) {
          // A signal or spawn failure without an exit code.
          reject(new CalendarError('CALENDAR_CREDENTIAL_STORE', `Could not run ${file}: ${error.message}`))
          return
        }
        resolve({ code, stdout, stderr })
      },
    )
    if (options.stdin !== undefined && child.stdin !== null) {
      child.stdin.end(options.stdin)
    } else if (child.stdin !== null) {
      child.stdin.end()
    }
  })
}

function accountKey(account: string): string {
  return createHash('sha256').update(account.trim().toLowerCase()).digest('hex').slice(0, 16)
}

/** PowerShell executable preference: Windows PowerShell 5.1 always exists. */
function powershellFile(): string {
  return process.env['DSH_ICLOUD_CALENDAR_POWERSHELL'] ?? 'powershell.exe'
}

class DpapiStore implements SecureStore {
  private readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  get description(): SecureStoreDescription {
    return { kind: 'dpapi', location: this.directory, available: process.platform === 'win32' }
  }

  private fileFor(account: string): string {
    return join(this.directory, `credentials-${accountKey(account)}.dpapi.xml`)
  }

  async get(account: string): Promise<string | undefined> {
    if (process.platform !== 'win32') {
      throw new CalendarError('CALENDAR_CREDENTIAL_STORE', 'The dpapi backend only works on Windows.')
    }
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'if (-not (Test-Path -LiteralPath $env:DSH_ICLOUD_STORE_FILE)) { exit 3 }',
      '$encrypted = Get-Content -LiteralPath $env:DSH_ICLOUD_STORE_FILE -Raw',
      '$secure = ConvertTo-SecureString -String $encrypted',
      '$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
      'try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }',
    ].join('; ')
    const result = await run(powershellFile(), ['-NoProfile', '-NonInteractive', '-Command', script], {
      // A variable name without the word "password": several log scrubbers
      // redact whole lines that contain it and would corrupt the blob path.
      env: { DSH_ICLOUD_STORE_FILE: this.fileFor(account) },
    })
    if (result.code === 3) return undefined
    if (result.code !== 0) {
      throw new CalendarError('CALENDAR_CREDENTIAL_STORE', `Could not read the DPAPI secret (exit ${result.code}).`, {
        stderr: result.stderr.trim().slice(0, 400),
      })
    }
    const secret = result.stdout
    return secret === '' ? undefined : secret
  }

  async set(account: string, secret: string): Promise<void> {
    if (process.platform !== 'win32') {
      throw new CalendarError('CALENDAR_CREDENTIAL_STORE', 'The dpapi backend only works on Windows.')
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '$plain = [Console]::In.ReadToEnd()',
      '$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force',
      '$encrypted = ConvertFrom-SecureString -SecureString $secure',
      'Set-Content -LiteralPath $env:DSH_ICLOUD_STORE_FILE -Value $encrypted -NoNewline -Encoding ASCII',
    ].join('; ')
    const result = await run(powershellFile(), ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdin: secret,
      env: { DSH_ICLOUD_STORE_FILE: this.fileFor(account) },
    })
    if (result.code !== 0) {
      throw new CalendarError('CALENDAR_CREDENTIAL_STORE', `Could not store the DPAPI secret (exit ${result.code}).`, {
        stderr: result.stderr.trim().slice(0, 400),
      })
    }
  }

  async remove(account: string): Promise<boolean> {
    try {
      await rm(this.fileFor(account))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw new CalendarError('CALENDAR_CREDENTIAL_STORE', `Could not remove the DPAPI secret: ${(error as Error).message}`)
    }
  }
}

class KeychainStore implements SecureStore {
  get description(): SecureStoreDescription {
    return { kind: 'keychain', location: `login keychain, service ${STORE_SERVICE}`, available: process.platform === 'darwin' }
  }

  async get(account: string): Promise<string | undefined> {
    const result = await run('security', ['find-generic-password', '-s', STORE_SERVICE, '-a', account, '-w'])
    if (result.code === 44 || result.code === 1) return undefined
    if (result.code !== 0) {
      throw new CalendarError('CALENDAR_CREDENTIAL_STORE', `Could not read the Keychain item (exit ${result.code}).`, {
        stderr: result.stderr.trim().slice(0, 400),
      })
    }
    const secret = result.stdout.replace(/\r?\n$/, '')
    return secret === '' ? undefined : secret
  }

  async set(account: string, secret: string): Promise<void> {
    // `security` only accepts the secret as an argument; it is documented as the
    // one backend where argv briefly holds the value.
    const result = await run('security', ['add-generic-password', '-U', '-s', STORE_SERVICE, '-a', account, '-w', secret])
    if (result.code !== 0) {
      throw new CalendarError('CALENDAR_CREDENTIAL_STORE', `Could not write the Keychain item (exit ${result.code}).`, {
        stderr: result.stderr.trim().slice(0, 400),
      })
    }
  }

  async remove(account: string): Promise<boolean> {
    const result = await run('security', ['delete-generic-password', '-s', STORE_SERVICE, '-a', account])
    return result.code === 0
  }
}

class SecretToolStore implements SecureStore {
  get description(): SecureStoreDescription {
    return { kind: 'secret-tool', location: `libsecret, service ${STORE_SERVICE}`, available: process.platform === 'linux' }
  }

  async get(account: string): Promise<string | undefined> {
    const result = await run('secret-tool', ['lookup', 'service', STORE_SERVICE, 'account', account])
    if (result.code === 1) return undefined
    if (result.code !== 0) {
      throw new CalendarError('CALENDAR_CREDENTIAL_STORE', `Could not read the libsecret item (exit ${result.code}).`, {
        stderr: result.stderr.trim().slice(0, 400),
      })
    }
    const secret = result.stdout.replace(/\r?\n$/, '')
    return secret === '' ? undefined : secret
  }

  async set(account: string, secret: string): Promise<void> {
    const result = await run(
      'secret-tool',
      ['store', '--label', `${STORE_SERVICE} (${account})`, 'service', STORE_SERVICE, 'account', account],
      { stdin: secret },
    )
    if (result.code !== 0) {
      throw new CalendarError('CALENDAR_CREDENTIAL_STORE', `Could not write the libsecret item (exit ${result.code}).`, {
        stderr: result.stderr.trim().slice(0, 400),
      })
    }
  }

  async remove(account: string): Promise<boolean> {
    const result = await run('secret-tool', ['clear', 'service', STORE_SERVICE, 'account', account])
    return result.code === 0
  }
}

class NullStore implements SecureStore {
  get description(): SecureStoreDescription {
    return { kind: 'none', location: null, available: false }
  }

  async get(): Promise<string | undefined> {
    return undefined
  }

  async set(): Promise<void> {
    throw new CalendarError(
      'CALENDAR_CREDENTIAL_STORE',
      'No credential store is selected. Set the app-specific password in the environment instead, or choose a store backend.',
    )
  }

  async remove(): Promise<boolean> {
    return false
  }
}

/** Builds the store for one selector, defaulting to the platform backend. */
export function createSecureStore(
  selector: SecureStoreSelector = 'auto',
  options: { directory?: string } = {},
): SecureStore {
  const kind = selector === 'auto' ? defaultStoreKind() : selector
  switch (kind) {
    case 'dpapi':
      return new DpapiStore(options.directory ?? defaultStoreDirectory())
    case 'keychain':
      return new KeychainStore()
    case 'secret-tool':
      return new SecretToolStore()
    case 'none':
      return new NullStore()
  }
}
