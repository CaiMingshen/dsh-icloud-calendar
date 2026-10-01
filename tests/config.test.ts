import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_ENV,
  DEFAULT_CONFIG,
  DEFAULT_SECRET_ENV,
  assertPolicy,
  assertServerUrl,
  assertStoreKind,
  describeConfiguration,
  resolveAccount,
  resolveConfig,
  resolveCredentials,
  resolveSecret,
  storeFor,
} from '../src/config.js'
import { createSecureStore, defaultStoreKind, type SecureStore } from '../src/credentials.js'

const SECRET = 'abcd-efgh-ijkl-mnop'

/** An in-memory stand-in for a platform credential store. */
function memoryStore(initial?: string): SecureStore & { value: string | undefined } {
  const box = {
    value: initial,
    description: { kind: 'none' as const, location: null, available: true },
    get: async (): Promise<string | undefined> => box.value,
    set: async (_account: string, secret: string): Promise<void> => {
      box.value = secret
    },
    remove: async (): Promise<boolean> => {
      const had = box.value !== undefined
      box.value = undefined
      return had
    },
  }
  return box
}

describe('defaults and validation', () => {
  it('resolves a complete config from partial input', () => {
    const config = resolveConfig({ account: 'me@example.com' })
    expect(config.account).toBe('me@example.com')
    expect(config.serverUrl).toBe('https://caldav.icloud.com/')
    expect(config.timeoutMs).toBe(DEFAULT_CONFIG.timeoutMs)
  })

  it('requires HTTPS and refuses embedded credentials', () => {
    expect(() => assertServerUrl('http://caldav.example.com/')).toThrowError(/must use HTTPS/)
    expect(() => assertServerUrl('https://user:pass@caldav.icloud.com/')).toThrowError(/must not embed/)
    expect(() => assertServerUrl('https://caldav.icloud.com/?x=1')).toThrowError(/query/)
    expect(assertServerUrl('https://caldav.icloud.com/')).toBe('https://caldav.icloud.com/')
  })

  it('accepts plain HTTP on loopback for a self-hosted server', () => {
    // Radicale/Nextcloud/Baikal on the same machine are routinely plain HTTP and
    // are unreachable from anywhere else, so the HTTPS rule has this one hole.
    expect(assertServerUrl('http://127.0.0.1:5232/')).toBe('http://127.0.0.1:5232/')
    expect(assertServerUrl('http://localhost:8080/')).toBe('http://localhost:8080/')
    expect(assertServerUrl('http://[::1]:8080/')).toBe('http://[::1]:8080/')
    expect(() => assertServerUrl('http://192.168.1.10:5232/')).toThrowError(/loopback/)
  })

  it('refuses unknown policy and store values', () => {
    expect(() => assertPolicy('maybe')).toThrowError(/secretSource must be one of/)
    expect(() => assertStoreKind('keepass')).toThrowError(/storeKind must be one of/)
  })

  it('picks the platform store', () => {
    expect(defaultStoreKind('win32')).toBe('dpapi')
    expect(defaultStoreKind('darwin')).toBe('keychain')
    expect(defaultStoreKind('linux')).toBe('secret-tool')
    expect(defaultStoreKind('freebsd')).toBe('none')
  })

  it('lets the environment override the configured store kind', () => {
    const store = storeFor(resolveConfig({ storeKind: 'dpapi' }), { [DEFAULT_CONFIG.storeKind === '' ? 'x' : 'DSH_ICLOUD_CALENDAR_STORE']: 'none' })
    expect(store.description.kind).toBe('none')
  })
})

describe('account and secret resolution', () => {
  it('prefers the configured account over the environment', () => {
    expect(resolveAccount(resolveConfig({ account: 'a@b.c' }), { [ACCOUNT_ENV]: 'env@b.c' })).toBe('a@b.c')
    expect(resolveAccount(resolveConfig(), { [ACCOUNT_ENV]: 'env@b.c' })).toBe('env@b.c')
    expect(() => resolveAccount(resolveConfig(), {})).toThrowError(new RegExp(ACCOUNT_ENV))
  })

  it('prefers a stored secret over the environment in auto mode', async () => {
    const store = memoryStore(SECRET)
    const config = resolveConfig({ account: 'a@b.c' })
    const resolved = await resolveSecret(config, 'a@b.c', store, { [DEFAULT_SECRET_ENV]: 'from-env' })
    expect(resolved).toEqual({ secret: SECRET, source: 'store' })
  })

  it('falls back to the environment when the store is empty', async () => {
    const store = memoryStore(undefined)
    const resolved = await resolveSecret(resolveConfig({ account: 'a@b.c' }), 'a@b.c', store, { [DEFAULT_SECRET_ENV]: 'from-env' })
    expect(resolved).toEqual({ secret: 'from-env', source: 'env' })
  })

  it('honours a pinned source', async () => {
    const store = memoryStore(SECRET)
    const envConfig = resolveConfig({ account: 'a@b.c', secretSource: 'env' })
    await expect(resolveSecret(envConfig, 'a@b.c', store, {})).rejects.toMatchObject({ code: 'CALENDAR_NOT_CONFIGURED' })
    const storeConfig = resolveConfig({ account: 'a@b.c', secretSource: 'store' })
    const resolved = await resolveSecret(storeConfig, 'a@b.c', store, { [DEFAULT_SECRET_ENV]: 'from-env' })
    expect(resolved.source).toBe('store')
  })

  it('explains what to do when nothing is configured', async () => {
    await expect(
      resolveSecret(resolveConfig({ account: 'a@b.c' }), 'a@b.c', memoryStore(undefined), {}),
    ).rejects.toThrowError(/App-Specific Passwords/)
  })

  it('assembles credentials and reports their provenance', async () => {
    const store = memoryStore(SECRET)
    const resolved = await resolveCredentials(resolveConfig({ account: 'a@b.c' }), store, {})
    expect(resolved.credentials).toEqual({ account: 'a@b.c', secret: SECRET, serverUrl: 'https://caldav.icloud.com/' })
    expect(resolved.source).toBe('store')
  })
})

describe('status description', () => {
  it('never carries the secret', () => {
    const store = memoryStore(SECRET)
    const description = describeConfiguration(resolveConfig({ account: 'a@b.c' }), store, {})
    expect(JSON.stringify(description)).not.toContain(SECRET)
    expect(description.account).toBe('a@b.c')
    expect(description.deletesAllowed).toBe(false)
  })

  it('reports a missing account as null instead of throwing', () => {
    expect(describeConfiguration(resolveConfig(), memoryStore(), {}).account).toBeNull()
  })
})

describe('the null store', () => {
  it('reads nothing and refuses to write', async () => {
    const store = createSecureStore('none')
    expect(await store.get('a@b.c')).toBeUndefined()
    await expect(store.set('a@b.c', SECRET)).rejects.toMatchObject({ code: 'CALENDAR_CREDENTIAL_STORE' })
    expect(store.description.available).toBe(false)
  })
})
