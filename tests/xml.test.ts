/**
 * The DAV reader is small and hand-written, so it gets its own suite: a bug here
 * silently changes what the client believes the server published.
 */

import { describe, expect, it } from 'vitest'
import { allTags, decodeEntities, firstTag, hasTag, parseMultistatus, parseStatusLine, resolveHref, tagText } from '../src/xml.js'

describe('allTags', () => {
  it('returns every self-closing element, not just the first', () => {
    // Regression: a calendar that publishes several component types lists them
    // as sibling self-closing elements. Stopping at the first one made the
    // client believe a VTODO+VEVENT calendar was events-free, so it was skipped.
    const xml = '<x><c:comp name="VTODO"/><c:comp name="VEVENT"/></x>'
    const comps = allTags(xml, 'comp')
    expect(comps.map((comp) => comp.attributes.trim())).toEqual(['name="VTODO"', 'name="VEVENT"'])
  })

  it('returns every paired element in document order', () => {
    const xml = '<a><b>1</b><b>2</b><b>3</b></a>'
    expect(allTags(xml, 'b').map((match) => match.inner)).toEqual(['1', '2', '3'])
  })

  it('does not descend into a matched element', () => {
    const xml = '<a><b>outer<b>inner</b></b></a>'
    // The nested <b> lives inside the first match's inner text, which is exactly
    // how multistatus responses are laid out.
    expect(allTags(xml, 'b')).toHaveLength(1)
  })

  it('returns nothing for a name that is absent', () => {
    expect(allTags('<a/>', 'missing')).toEqual([])
  })
})

describe('firstTag and tagText', () => {
  it('finds an element behind any namespace prefix', () => {
    const xml = '<d:prop><cal:displayname>Home</cal:displayname></d:prop>'
    expect(tagText(xml, 'displayname')).toBe('Home')
    expect(firstTag(xml, 'displayname')?.inner).toBe('Home')
  })

  it('reads the href nested inside a property, which is how discovery works', () => {
    const xml = '<d:current-user-principal><d:href>/123456789/principal/</d:href></d:current-user-principal>'
    const block = firstTag(xml, 'current-user-principal')
    expect(block).toBeDefined()
    expect(tagText(block?.inner ?? '', 'href')).toBe('/123456789/principal/')
  })

  it('decodes entities in text and numeric character references', () => {
    expect(tagText('<a>Tom &amp; Jerry</a>', 'a')).toBe('Tom & Jerry')
    expect(decodeEntities('&#65;&#x42;')).toBe('AB')
    expect(decodeEntities('&unknown;')).toBe('&unknown;')
  })

  it('reports presence without needing the value', () => {
    expect(hasTag('<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>', 'calendar')).toBe(true)
    expect(hasTag('<d:resourcetype><d:collection/></d:resourcetype>', 'calendar')).toBe(false)
  })
})

describe('parseMultistatus', () => {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/123456789/calendars/home/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Home</d:displayname>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/123456789/calendars/home/event.ics</d:href>
    <d:propstat>
      <d:prop><d:getetag>"abc"</d:getetag><c:calendar-data>BEGIN:VCALENDAR&#13;
END:VCALENDAR&#13;
</c:calendar-data></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`

  it('extracts one entry per response, with status and properties', () => {
    const entries = parseMultistatus(body)
    expect(entries).toHaveLength(2)
    expect(entries[0]?.href).toBe('/123456789/calendars/home/')
    expect(entries[0]?.status).toBe(200)
    expect(tagText(entries[0]?.props ?? '', 'displayname')).toBe('Home')
    expect(allTags(entries[0]?.props ?? '', 'comp')).toHaveLength(1)
    expect(tagText(entries[1]?.props ?? '', 'getetag')).toBe('"abc"')
  })

  it('keeps the escaped iCalendar payload intact for the parser to unescape', () => {
    const entries = parseMultistatus(body)
    expect(entries[1]?.props).toContain('BEGIN:VCALENDAR&#13;')
  })

  it('parses a status line, ignoring the reason phrase', () => {
    expect(parseStatusLine('HTTP/1.1 404 Not Found')).toBe(404)
    expect(parseStatusLine(undefined)).toBeUndefined()
  })
})

describe('resolveHref', () => {
  it('resolves a server-relative href against the request URL', () => {
    expect(resolveHref('/123456789/calendars/', 'https://caldav.icloud.com/')).toBe('https://caldav.icloud.com/123456789/calendars/')
  })

  it('keeps an absolute href as it is', () => {
    const url = 'https://caldav.icloud.com/1/calendars/home/'
    expect(resolveHref(url, 'https://caldav.icloud.com/')).toBe(url)
  })

  it('returns an unusable href unchanged instead of throwing', () => {
    expect(resolveHref('<d:href>', 'https://caldav.icloud.com/')).toBe('<d:href>')
  })
})
