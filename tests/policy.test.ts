import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, resolveConfig, type Config } from '../src/config.js'
import { runDelete, type DeleteDeps } from '../src/policy.js'
import type { CalendarSummary, ListEventsResult, MatchedEvent } from '../src/types.js'

const CALENDAR: CalendarSummary = {
  id: 'https://caldav.icloud.com/1/calendars/home/',
  url: 'https://caldav.icloud.com/1/calendars/home/',
  name: 'Home',
  components: ['VEVENT'],
  supportsEvents: true,
  readOnly: false,
}

function event(summary: string, uid: string, url = `https://x/${uid}.ics`): {
  uid: string
  summary: string
  start: string
  end: string
  calendar: { id: string; name: string }
  url: string
  etag?: string
} {
  return {
    uid,
    summary,
    start: '2026-01-05T01:00:00.000Z',
    end: '2026-01-05T02:00:00.000Z',
    calendar: { id: CALENDAR.id, name: CALENDAR.name },
    url,
    etag: `"${uid}-1"`,
  }
}

interface Harness {
  deps: DeleteDeps
  deleted: Array<{ url: string; etag: string | undefined }>
}

function harness(events: ReturnType<typeof event>[], config: Partial<Config> = {}): Harness {
  const deleted: Array<{ url: string; etag: string | undefined }> = []
  const resolved = resolveConfig({ allowDeletes: true, ...config })
  const deps: DeleteDeps = {
    config: resolved,
    selectCalendars: async () => [CALENDAR],
    listEvents: async (): Promise<ListEventsResult> => ({
      window: { start: '2026-01-01', end: '2026-02-01' },
      calendars: [{ id: CALENDAR.id, name: CALENDAR.name }],
      events: events.map((entry) => ({ ...entry, allDay: false, recurring: false })),
      total: events.length,
      truncatedSeries: [],
    }),
    deleteObject: async (url, etag) => {
      deleted.push({ url, etag })
    },
  }
  return { deps, deleted }
}

const baseRequest = { start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z' }

describe('delete guard', () => {
  it('refuses to run while deletes are disabled in the profile', async () => {
    const { deps } = harness([event('Standup', 'u1')], { allowDeletes: false })
    await expect(runDelete(deps, { ...baseRequest, uid: 'u1' })).rejects.toMatchObject({ code: 'CALENDAR_READ_ONLY' })
  })

  it('refuses a target that is not named exactly', async () => {
    const { deps } = harness([event('Standup', 'u1')])
    await expect(runDelete(deps, baseRequest)).rejects.toMatchObject({ code: 'CALENDAR_UNSAFE_DELETE' })
  })

  it('does not match a partial title', async () => {
    const { deps, deleted } = harness([event('Weekly standup with the platform team', 'u1')])
    const result = await runDelete(deps, { ...baseRequest, summaryEquals: 'standup' })
    expect(result.matched).toHaveLength(0)
    expect(deleted).toHaveLength(0)
  })

  it('is a dry run by default and deletes nothing', async () => {
    const { deps, deleted } = harness([event('Standup', 'u1')])
    const result = await runDelete(deps, { ...baseRequest, uid: 'u1' })
    expect(result.dryRun).toBe(true)
    expect(result.count).toBe(1)
    expect(result.matched[0]?.summary).toBe('Standup')
    expect(deleted).toHaveLength(0)
    expect(result.notes.join(' ')).toMatch(/dry run/i)
  })

  it('requires confirmCount to equal the matched object count', async () => {
    const { deps, deleted } = harness([event('Standup', 'u1')])
    await expect(
      runDelete(deps, { ...baseRequest, uid: 'u1', dryRun: false, confirmCount: 3 }),
    ).rejects.toMatchObject({ code: 'CALENDAR_UNSAFE_DELETE' })
    expect(deleted).toHaveLength(0)
  })

  it('deletes exactly the confirmed object', async () => {
    const { deps, deleted } = harness([event('Standup', 'u1')])
    const result = await runDelete(deps, { ...baseRequest, uid: 'u1', dryRun: false, confirmCount: 1 })
    expect(result.dryRun).toBe(false)
    expect(result.deleted).toHaveLength(1)
    expect(deleted[0]?.etag).toBe('"u1-1"')
  })

  it('counts a recurring series once and says so', async () => {
    const occurrences = [
      event('Weekly sync', 'series-1', 'https://x/series-1.ics'),
      event('Weekly sync', 'series-1', 'https://x/series-1.ics'),
      event('Weekly sync', 'series-1', 'https://x/series-1.ics'),
    ]
    const { deps, deleted } = harness(occurrences)
    const preview = await runDelete(deps, { ...baseRequest, uid: 'series-1' })
    expect(preview.count).toBe(1)
    expect(preview.matched).toHaveLength(3)
    expect(preview.notes.join(' ')).toMatch(/whole recurring series/)
    await runDelete(deps, { ...baseRequest, uid: 'series-1', dryRun: false, confirmCount: 1 })
    expect(deleted).toHaveLength(1)
  })

  it('refuses a match larger than the per-call cap', async () => {
    const { deps } = harness([event('A', 'u1'), event('A', 'u2')], { maxDeletesPerCall: 1 })
    await expect(runDelete(deps, { ...baseRequest, summaryEquals: 'A' })).rejects.toMatchObject({
      code: 'CALENDAR_UNSAFE_DELETE',
      detail: { matched: 2, cap: 1 },
    })
  })

  it('never lets a call raise the configured cap', async () => {
    const { deps } = harness([event('A', 'u1'), event('A', 'u2')], { maxDeletesPerCall: 1 })
    await expect(runDelete(deps, { ...baseRequest, summaryEquals: 'A', maxDeletes: 99 })).rejects.toMatchObject({
      code: 'CALENDAR_UNSAFE_DELETE',
    })
  })

  it('reports an empty match without deleting', async () => {
    const { deps, deleted } = harness([event('Standup', 'u1')])
    const result = await runDelete(deps, { ...baseRequest, uid: 'nope', dryRun: false, confirmCount: 0 })
    expect(result.count).toBe(0)
    expect(deleted).toHaveLength(0)
    expect(result.notes[0]).toMatch(/Nothing matched/)
  })
})

describe('defaults', () => {
  it('ships with deletes disabled and a one-object cap', () => {
    expect(DEFAULT_CONFIG.allowDeletes).toBe(false)
    expect(DEFAULT_CONFIG.maxDeletesPerCall).toBe(1)
    expect(DEFAULT_CONFIG.maxDeleteWindowDays).toBeLessThan(DEFAULT_CONFIG.maxWindowDays)
  })
})
