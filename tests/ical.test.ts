import { describe, expect, it } from 'vitest'
import {
  buildEventIcs,
  parseCalendarObject,
  parseCalendarObjects,
  parseInstant,
  resolveWindow,
  sortEvents,
} from '../src/ical.js'
import type { EventWindow } from '../src/types.js'

function window(start: string, end: string): EventWindow {
  return resolveWindow(start, end, 400 * 86_400_000)
}

const WEEKLY = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//test//EN',
  'BEGIN:VEVENT',
  'UID:weekly-1',
  'DTSTAMP:20260101T000000Z',
  'SUMMARY:Weekly sync',
  'DTSTART:20260105T010000Z',
  'DTEND:20260105T020000Z',
  'RRULE:FREQ=WEEKLY;COUNT=10',
  'EXDATE:20260119T010000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const ALL_DAY = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//test//EN',
  'BEGIN:VEVENT',
  'UID:allday-1',
  'DTSTAMP:20260101T000000Z',
  'SUMMARY:Company holiday',
  'DTSTART;VALUE=DATE:20260106',
  'DTEND;VALUE=DATE:20260107',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const input = (slug: string, ics: string) => ({
  url: `https://caldav.icloud.com/1/calendars/home/${slug}.ics`,
  data: ics,
  calendar: { id: 'https://caldav.icloud.com/1/calendars/home/', name: 'Home' },
})

describe('parseInstant', () => {
  it('reads a date-only value as an all-day instant', () => {
    const parsed = parseInstant('2026-01-05', 'start')
    expect(parsed.kind).toBe('date')
    expect(parsed.date.toISOString()).toBe('2026-01-05T00:00:00.000Z')
  })

  it('reads an offset-bearing timestamp as a timed instant', () => {
    const parsed = parseInstant('2026-01-05T09:00:00+08:00', 'start')
    expect(parsed.kind).toBe('date-time')
    expect(parsed.date.toISOString()).toBe('2026-01-05T01:00:00.000Z')
  })

  it('refuses a timestamp with no offset instead of guessing a zone', () => {
    expect(() => parseInstant('2026-01-05T09:00:00', 'start')).toThrowError(/no usable offset/)
  })
})

describe('resolveWindow', () => {
  it('rejects an inverted window', () => {
    expect(() => resolveWindow('2026-01-06T00:00:00Z', '2026-01-05T00:00:00Z', 86_400_000)).toThrowError(/must be after/)
  })

  it('rejects a window longer than the cap', () => {
    expect(() => resolveWindow('2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z', 7 * 86_400_000)).toThrowError(
      /configured maximum is 7 days/,
    )
  })
})

describe('buildEventIcs', () => {
  it('writes an all-day event with an exclusive end', () => {
    const ics = buildEventIcs({
      uid: 'abc@test',
      summary: 'Offsite, day one; bring notes',
      start: parseInstant('2026-01-05', 'start'),
      end: parseInstant('2026-01-06', 'end'),
      allDay: true,
      stamp: new Date('2026-01-01T00:00:00Z'),
    })
    expect(ics).toContain('DTSTART;VALUE=DATE:20260105')
    expect(ics).toContain('DTEND;VALUE=DATE:20260106')
    // TEXT escaping: a comma and a semicolon are escaped, not dropped.
    expect(ics).toContain('SUMMARY:Offsite\\, day one\\; bring notes')
  })

  it('writes a timed event in the requested zone', () => {
    const ics = buildEventIcs({
      uid: 'abc@test',
      summary: 'Design review',
      start: parseInstant('2026-01-05T09:00:00+08:00', 'start'),
      end: parseInstant('2026-01-05T10:00:00+08:00', 'end'),
      allDay: false,
      timeZone: 'Asia/Shanghai',
      stamp: new Date('2026-01-01T00:00:00Z'),
    })
    expect(ics).toContain('DTSTART;TZID=Asia/Shanghai:20260105T090000')
    expect(ics).toContain('DTEND;TZID=Asia/Shanghai:20260105T100000')
  })

  it('folds long lines at 75 octets', () => {
    const ics = buildEventIcs({
      uid: 'abc@test',
      summary: 'x'.repeat(300),
      start: parseInstant('2026-01-05', 'start'),
      end: parseInstant('2026-01-06', 'end'),
      allDay: true,
      stamp: new Date('2026-01-01T00:00:00Z'),
    })
    for (const line of ics.split('\r\n')) {
      expect(Buffer.from(line, 'utf8').length).toBeLessThanOrEqual(76)
    }
  })
})

describe('parseCalendarObject', () => {
  it('expands a weekly rule into the occurrences inside the window', () => {
    const result = parseCalendarObject(input('weekly-1', WEEKLY), window('2026-01-05T00:00:00Z', '2026-02-03T00:00:00Z'), 100)
    // Five Mondays in the window, minus the excluded 19 January.
    expect(result.events.map((event) => event.start)).toEqual([
      '2026-01-05T01:00:00.000Z',
      '2026-01-12T01:00:00.000Z',
      '2026-01-26T01:00:00.000Z',
      '2026-02-02T01:00:00.000Z',
    ])
    expect(result.truncated).toBe(false)
    expect(result.events[0]?.uid).toBe('weekly-1')
    expect(result.events[0]?.recurring).toBe(true)
  })

  it('reports a series cut short by the occurrence bound', () => {
    const result = parseCalendarObject(input('weekly-1', WEEKLY), window('2026-01-05T00:00:00Z', '2026-06-01T00:00:00Z'), 2)
    expect(result.truncated).toBe(true)
    expect(result.events).toHaveLength(2)
  })

  it('keeps all-day events date-only with an exclusive end', () => {
    const result = parseCalendarObject(input('allday-1', ALL_DAY), window('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'), 10)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({ start: '2026-01-06', end: '2026-01-07', allDay: true })
  })

  it('drops objects that fall outside the window', () => {
    const result = parseCalendarObject(input('allday-1', ALL_DAY), window('2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z'), 10)
    expect(result.events).toHaveLength(0)
  })
})

describe('parseCalendarObjects', () => {
  it('names the series that was actually cut short', () => {
    // Regression: the truncated UID used to be read from the accumulated event
    // list, so with several objects the first one was blamed instead of the
    // series that hit the bound.
    const result = parseCalendarObjects(
      [input('allday-1', ALL_DAY), input('weekly-1', WEEKLY)],
      window('2026-01-05T00:00:00Z', '2026-06-01T00:00:00Z'),
      2,
    )
    expect(result.truncatedSeries).toEqual(['weekly-1'])
    expect(result.events.length).toBeGreaterThan(0)
  })

  it('reports no truncated series when everything fits', () => {
    const result = parseCalendarObjects(
      [input('allday-1', ALL_DAY)],
      window('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
      10,
    )
    expect(result.truncatedSeries).toEqual([])
  })
})

describe('sortEvents', () => {
  it('orders by start and then by title', () => {
    const base = {
      calendar: { id: 'c', name: 'Home' },
      end: '2026-01-05T02:00:00.000Z',
      allDay: false,
      recurring: false,
      url: 'u',
    }
    const sorted = sortEvents([
      { ...base, uid: 'b', summary: 'Beta', start: '2026-01-05T01:00:00.000Z' },
      { ...base, uid: 'a', summary: 'Alpha', start: '2026-01-05T01:00:00.000Z' },
      { ...base, uid: 'c', summary: 'Zeta', start: '2026-01-04T01:00:00.000Z' },
    ])
    expect(sorted.map((event) => event.summary)).toEqual(['Zeta', 'Alpha', 'Beta'])
  })
})
