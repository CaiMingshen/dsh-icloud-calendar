/**
 * A deliberately small, namespace-tolerant reader for the CalDAV XML this
 * plugin actually consumes.
 *
 * Why not a real XML library: the replies that matter are WebDAV multistatus
 * documents with a fixed, shallow shape, and the plugin should stay dependency
 * light in the code path that handles credentials. This module therefore
 * extracts the handful of properties the client needs and nothing else. It is
 * not a general XML parser, and it is not used for anything but server replies
 * the CalDAV client itself requested.
 *
 * Namespace prefixes vary (`d:`, `D:`, `cal:`, none), so every lookup matches a
 * local name with an optional prefix.
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/** Expands the five predefined XML entities plus numeric character references. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ENTITIES[body.toLowerCase()] ?? match
  })
}

interface TagMatch {
  /** Raw attributes text of the opening tag. */
  attributes: string
  /** Raw inner text between the opening and matching closing tag. */
  inner: string
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Returns the first element whose local name is `localName`, whatever prefix it
 * carries. Nested elements with the same name are not considered: the match is
 * the first opening tag and the first closing tag after it.
 */
export function firstTag(xml: string, localName: string): TagMatch | undefined {
  const open = new RegExp(`<([A-Za-z0-9_.-]+:)?${escapeForRegExp(localName)}(\\s[^>]*)?>`, 'i')
  const openMatch = open.exec(xml)
  if (openMatch === null || openMatch.index === undefined) return undefined
  // Drop a self-closing slash so callers see the same attributes either way.
  const attributes = (openMatch[2] ?? '').replace(/\/\s*$/, '')
  const selfClosing = openMatch[0].endsWith('/>')
  const innerStart = openMatch.index + openMatch[0].length
  if (selfClosing) return { attributes, inner: '' }
  const close = new RegExp(`</([A-Za-z0-9_.-]+:)?${escapeForRegExp(localName)}\\s*>`, 'i')
  const rest = xml.slice(innerStart)
  const closeMatch = close.exec(rest)
  if (closeMatch === null) return undefined
  return { attributes, inner: rest.slice(0, closeMatch.index) }
}

/** All elements with the given local name, in document order, non-nested. */
export function allTags(xml: string, localName: string): TagMatch[] {
  const results: TagMatch[] = []
  let cursor = xml
  for (;;) {
    const match = firstTag(cursor, localName)
    if (match === undefined) return results
    results.push(match)
    const open = new RegExp(`<([A-Za-z0-9_.-]+:)?${escapeForRegExp(localName)}(\\s[^>]*)?>`, 'i').exec(cursor)
    if (open === null || open.index === undefined) return results
    const innerStart = open.index + open[0].length
    if (open[0].endsWith('/>')) {
      // Self-closing: there is no closing tag to skip to, so advance past the
      // element itself. Without this the loop stops at the first match, which
      // silently truncates lists such as <comp name="VEVENT"/><comp name="VTODO"/>.
      cursor = cursor.slice(innerStart)
      continue
    }
    const close = new RegExp(`</([A-Za-z0-9_.-]+:)?${escapeForRegExp(localName)}\\s*>`, 'i').exec(cursor.slice(innerStart))
    if (close === null) return results
    cursor = cursor.slice(innerStart + close.index + close[0].length)
  }
}

/** Decoded text of the first matching element, or undefined when absent. */
export function tagText(xml: string, localName: string): string | undefined {
  const match = firstTag(xml, localName)
  if (match === undefined) return undefined
  return decodeEntities(match.inner.trim())
}

/** Raw (still entity-encoded) inner text — for `calendar-data`, which is CDATA-ish. */
export function tagRaw(xml: string, localName: string): string | undefined {
  const match = firstTag(xml, localName)
  return match?.inner
}

/** Whether an element with this local name occurs anywhere in the fragment. */
export function hasTag(xml: string, localName: string): boolean {
  return new RegExp(`<([A-Za-z0-9_.-]+:)?${escapeForRegExp(localName)}(\\s[^>]*)?/?>`, 'i').test(xml)
}

/** One `<response>` block from a multistatus body. */
export interface DavResponse {
  href: string
  /** Numeric status of the propstat that carried the properties. */
  status: number | undefined
  /** The matching `<prop>` fragment, empty when the reply had none. */
  props: string
  /** Response-level status, used by some servers instead of propstat. */
  responseStatus: number | undefined
}

/** Parses a `207 Multistatus` body into its response blocks. */
export function parseMultistatus(xml: string): DavResponse[] {
  return allTags(xml, 'response').map((response) => {
    const href = tagText(response.inner, 'href') ?? ''
    const propstats = allTags(response.inner, 'propstat')
    let status: number | undefined
    let props = ''
    for (const propstat of propstats) {
      const prop = firstTag(propstat.inner, 'prop')
      if (prop === undefined) continue
      if (props === '') props = prop.inner
      const parsed = parseStatusLine(tagText(propstat.inner, 'status'))
      if (parsed !== undefined) {
        status = parsed
        props = prop.inner
        break
      }
    }
    const responseStatus = parseStatusLine(tagText(response.inner, 'status'))
    return { href, status: status ?? responseStatus, props, responseStatus }
  })
}

/** Extracts the numeric status from a `HTTP/1.1 200 OK` status line. */
export function parseStatusLine(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const match = /(\d{3})/.exec(value)
  return match === null ? undefined : Number.parseInt(match[1] ?? '', 10)
}

/**
 * Resolves an href from a multistatus reply against the request URL.
 *
 * A value that is empty, or that still carries markup or whitespace, is handed
 * back unchanged: `new URL()` would happily percent-encode such input into a
 * syntactically valid request for something the server never meant, and a
 * visible bogus URL in an error is more useful than a silent 404 elsewhere.
 */
export function resolveHref(href: string, base: string): string {
  const value = href.trim()
  if (value === '' || /[\s<>"]/.test(value)) return href
  try {
    return new URL(value, base).toString()
  } catch {
    return href
  }
}

/** Escapes text for inclusion in an XML body or an iCalendar property. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** WebDAV/CalDAV request bodies this client sends. */
export const DAV_BODIES = {
  currentUserPrincipal: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:current-user-principal/>
  </d:prop>
</d:propfind>`,

  calendarHome: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-home-set/>
    <d:displayname/>
  </d:prop>
</d:propfind>`,

  calendars: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <d:current-user-privilege-set/>
    <c:supported-calendar-component-set/>
    <c:calendar-timezone/>
    <cs:getctag/>
    <x:calendar-color xmlns:x="http://apple.com/ns/ical/"/>
  </d:prop>
</d:propfind>`,

  /** One calendar-query limited to a time range; the shallow report we rely on. */
  calendarQuery: (start: string, end: string) => `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${start}" end="${end}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`,

  /** Direct object fetch, used to re-read one event before a mutation. */
  calendarObject: `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT"/>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`,
} as const
