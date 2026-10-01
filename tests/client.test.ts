import { afterEach, describe, expect, it } from 'vitest'
import { ICloudCalendarClient } from '../src/client.js'
import { CalendarError } from '../src/errors.js'
import { resolveWindow } from '../src/ical.js'
import { MockCalDav } from './mock-caldav.js'

const EVENT_ONE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//test//EN',
  'BEGIN:VEVENT',
  'UID:event-1',
  'DTSTAMP:20260101T000000Z',
  'SUMMARY:Standup',
  'DTSTART:20260105T010000Z',
  'DTEND:20260105T013000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const EVENT_OUTSIDE = EVENT_ONE.replace(/event-1/g, 'event-2').replace(/20260105/g, '20260305').replace('Standup', 'Far away')

let server: MockCalDav | undefined

afterEach(async () => {
  await server?.stop()
  server = undefined
})

async function connect(options: { retries?: number; timeoutMs?: number } = {}): Promise<{
  client: ICloudCalendarClient
  server: MockCalDav
  base: string
}> {
  server = new MockCalDav([
    { slug: 'home', name: 'Home' },
    { slug: 'work', name: 'Work', color: '#FF0000' },
    { slug: 'reminders', name: 'Reminders', components: ['VTODO'] },
    { slug: 'shared', name: 'Shared', readOnly: true },
    // Published with VTODO first: a reader that stops at the first component
    // element would call this calendar events-free and skip it entirely.
    { slug: 'mixed', name: 'Mixed', components: ['VTODO', 'VEVENT'] },
  ])
  const base = await server.start()
  const client = await ICloudCalendarClient.connect({
    credentials: { account: 'tester@example.com', secret: 'abcd-efgh-ijkl-mnop', serverUrl: base },
    timeoutMs: options.timeoutMs ?? 5_000,
    retries: options.retries ?? 0,
  })
  return { client, server, base }
}

describe('discovery and listing', () => {
  it('walks principal and home, then lists calendars with their capabilities', async () => {
    const { client } = await connect()
    const calendars = await client.listCalendars({})
    expect(calendars.map((calendar) => calendar.name)).toEqual(['Home', 'Work', 'Reminders', 'Shared', 'Mixed'])
    const reminders = calendars.find((calendar) => calendar.name === 'Reminders')
    expect(reminders?.supportsEvents).toBe(false)
    const shared = calendars.find((calendar) => calendar.name === 'Shared')
    expect(shared?.readOnly).toBe(true)
    const work = calendars.find((calendar) => calendar.name === 'Work')
    expect(work?.color).toBe('#FF0000')
    // A collection that accepts both VTODO and VEVENT still stores events.
    const mixed = calendars.find((calendar) => calendar.name === 'Mixed')
    expect(mixed?.components).toEqual(['VTODO', 'VEVENT'])
    expect(mixed?.supportsEvents).toBe(true)
  })

  it('serves a second listing from cache', async () => {
    const { client, server: mock } = await connect()
    await client.listCalendars({})
    const before = mock.requests.length
    await client.listCalendars({})
    expect(mock.requests.length).toBe(before)
  })
})

describe('reads', () => {
  it('returns only occurrences inside the window', async () => {
    const { client, server: mock } = await connect()
    mock.seed('home', 'event-1', EVENT_ONE)
    mock.seed('home', 'event-2', EVENT_OUTSIDE)
    const result = await client.listEvents(resolveWindow('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 400 * 86_400_000))
    expect(result.events.map((event) => event.summary)).toEqual(['Standup'])
    expect(result.total).toBe(1)
  })

  it('honours the limit while still reporting the full total', async () => {
    const { client, server: mock } = await connect()
    mock.seed('home', 'event-1', EVENT_ONE)
    mock.seed('home', 'event-2', EVENT_OUTSIDE)
    const result = await client.listEvents(
      resolveWindow('2026-01-01T00:00:00Z', '2026-04-01T00:00:00Z', 400 * 86_400_000),
      { limit: 1 },
    )
    expect(result.events).toHaveLength(1)
    expect(result.total).toBe(2)
  })

  it('rejects naming a Reminders list as an event calendar', async () => {
    const { client } = await connect()
    const calendars = await client.listCalendars({})
    expect(() => client.resolveCalendar(calendars, 'Reminders')).toThrowError(/Reminders list/)
  })

  it('refuses an ambiguous target when several calendars qualify', async () => {
    const { client } = await connect()
    const calendars = await client.listCalendars({})
    expect(() => client.resolveCalendar(calendars, undefined)).toThrowError(/Name a calendar explicitly/)
  })
})

describe('writes', () => {
  it('creates an event with a PUT and returns its handle', async () => {
    const { client, server: mock } = await connect()
    const calendars = await client.listCalendars({})
    const home = client.resolveCalendar(calendars, 'Home')
    const created = await client.createEvent(home, {
      summary: 'Design review',
      start: '2026-01-05T09:00:00+08:00',
      end: '2026-01-05T10:00:00+08:00',
      timeZone: 'Asia/Shanghai',
    })
    expect(created.allDay).toBe(false)
    expect(created.url).toContain('/calendars/home/')
    const put = mock.requests.find((request) => request.method === 'PUT')
    expect(put?.body).toContain('TZID=Asia/Shanghai')
    expect(put?.body).toContain('SUMMARY:Design review')
    // Regression: the XML default used to overwrite the caller's content-type,
    // so an .ics body went out as application/xml and iCloud answered 501.
    expect(put?.contentType).toContain('text/calendar')
    expect(mock.objects.size).toBe(1)
  })

  it('sends XML as the body type for the discovery and query verbs', async () => {
    const { client, server: mock } = await connect()
    await client.listCalendars({})
    const propfind = mock.requests.find((request) => request.method === 'PROPFIND' && request.body !== '')
    expect(propfind?.contentType).toContain('application/xml')
  })

  it('deletes one object and reports the DELETE it sent', async () => {
    const { client, server: mock } = await connect()
    mock.seed('home', 'event-1.ics', EVENT_ONE, '"etag-1"')
    const calendars = await client.listCalendars({})
    const home = client.resolveCalendar(calendars, 'Home')
    const result = await client.listEvents(resolveWindow('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 400 * 86_400_000), {
      calendars: [home],
    })
    const event = result.events[0]
    expect(event).toBeDefined()
    await client.deleteObject(event?.url ?? '', event?.etag)
    expect(mock.objects.size).toBe(0)
    const sent = mock.requests.find((request) => request.method === 'DELETE')
    expect(sent?.path).toContain('/calendars/home/event-1.ics')
  })
})

describe('failure handling', () => {
  it('maps a rejected password to CALENDAR_AUTH_FAILED without retrying', async () => {
    server = new MockCalDav([{ slug: 'home', name: 'Home' }])
    server.rejectAuth = true
    const base = await server.start()
    await expect(
      ICloudCalendarClient.connect({
        credentials: { account: 'tester@example.com', secret: 'wrong', serverUrl: base },
        retries: 3,
      }),
    ).rejects.toMatchObject({ code: 'CALENDAR_AUTH_FAILED' })
    expect(server.requests).toHaveLength(1)
  })

  it('retries a transient 503 and then succeeds', async () => {
    const { client, server: mock } = await connect({ retries: 2 })
    mock.failNext = 2
    const calendars = await client.listCalendars({})
    expect(calendars).toHaveLength(5)
    expect(mock.requests.filter((request) => request.path === '/123456789/calendars/').length).toBe(3)
  })

  it('gives up with CALENDAR_TIMEOUT when the server never answers in time', async () => {
    server = new MockCalDav([{ slug: 'home', name: 'Home' }])
    server.delayMs = 400
    const base = await server.start()
    await expect(
      ICloudCalendarClient.connect({
        credentials: { account: 'tester@example.com', secret: 'abcd-efgh-ijkl-mnop', serverUrl: base },
        timeoutMs: 60,
        retries: 0,
      }),
    ).rejects.toMatchObject({ code: 'CALENDAR_TIMEOUT' })
  })

  it('surfaces unreachable hosts as a CalendarError', async () => {
    await expect(
      ICloudCalendarClient.connect({
        credentials: { account: 'a@b.c', secret: 'x', serverUrl: 'http://127.0.0.1:1/' },
        timeoutMs: 500,
        retries: 0,
      }),
    ).rejects.toBeInstanceOf(CalendarError)
  })
})
