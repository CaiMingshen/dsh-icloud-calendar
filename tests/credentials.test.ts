import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSecureStore, defaultStoreDirectory, STORE_SERVICE } from '../src/credentials.js'

const isWindows = process.platform === 'win32'

describe('store selection', () => {
  it('names the service it stores under', () => {
    expect(STORE_SERVICE).toBe('dsh-icloud-calendar')
  })

  it('places the DPAPI blob outside any repository by default', () => {
    const directory = defaultStoreDirectory({ LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' })
    expect(directory).toBe(join('C:\\Users\\tester\\AppData\\Local', STORE_SERVICE))
  })
})

describe.skipIf(!isWindows)('DPAPI store on Windows', () => {
  it('round-trips a secret and removes it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-icloud-calendar-test-'))
    const store = createSecureStore('dpapi', { directory })
    const account = 'tester@example.com'
    const secret = 'abcd-efgh-ijkl-mnop'
    try {
      expect(await store.get(account)).toBeUndefined()
      await store.set(account, secret)
      expect(await store.get(account)).toBe(secret)
      expect(store.description.kind).toBe('dpapi')
      expect(store.description.available).toBe(true)
      expect(await store.remove(account)).toBe(true)
      expect(await store.get(account)).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps two accounts apart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-icloud-calendar-test-'))
    const store = createSecureStore('dpapi', { directory })
    try {
      await store.set('one@example.com', 'secret-one')
      await store.set('two@example.com', 'secret-two')
      expect(await store.get('one@example.com')).toBe('secret-one')
      expect(await store.get('two@example.com')).toBe('secret-two')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
