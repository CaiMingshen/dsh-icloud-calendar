/**
 * An in-process CalDAV server for tests.
 *
 * It implements exactly the surface the client uses — discovery PROPFINDs, a
 * calendar-query REPORT, GET, PUT and DELETE — plus the failure switches the
 * tests need: reject credentials, answer slowly, or fail the next N requests
 * with 503. No Apple ID, no network, no fixtures on disk.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One calendar collection the mock publishes. */
export interface MockCalendar {
  /** Path under the home, for example `home`. */
  slug: string
  name: string
  components?: string[]
  readOnly?: boolean
  color?: string
}

/** One stored object. */
export interface MockObject {
  /** Path under the calendar, for example `event-1.ics`. */
  slug: string
  calendarSlug: string
  ics: string
  etag: string
}

/** What the mock recorded about one request, for assertions. */
export interface RecordedRequest {
  method: string
  path: string
  depth: string | undefined
  body: string
  /** Declared body type; a PUT of iCalendar must not say application/xml. */
  contentType: string | undefined
}

const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>'

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function multistatus(responses: string[]): string {
  return `${XML_HEADER}<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:x="http://apple.com/ns/ical/">${responses.join('')}</d:multistatus>`
}

/** Reads DTSTART values out of an ICS body, for the time-range filter. */
function eventStarts(ics: string): string[] {
  const unfolded = ics.replace(/\r\n[ \t]/g, '')
  return [...unfolded.matchAll(/^DTSTART[^:]*:(\d{8}(T\d{6}Z?)?)/gm)].map((match) => match[1] ?? '')
}

function toComparable(value: string): number {
  if (value.length === 8) return Date.parse(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`)
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`
  return Date.parse(iso)
}

/** A CalDAV server the tests can drive. */
export class MockCalDav {
  readonly requests: RecordedRequest[] = []
  readonly objects = new Map<string, MockObject>()
  /** Next N requests fail with 503, to exercise the retry path. */
  failNext = 0
  /** Milliseconds to wait before answering, to exercise the deadline. */
  delayMs = 0
  /** Answer every request with 401, to exercise the auth path. */
  rejectAuth = false

  private server: Server | undefined
  private base: string | undefined

  constructor(
    private readonly calendars: readonly MockCalendar[],
    private readonly account = 'tester@example.com',
    private readonly secret = 'abcd-efgh-ijkl-mnop',
    private readonly principalId = '123456789',
  ) {}

  /** Starts the server and returns its CalDAV entry point. */
  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.handle(request, response)
    })
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve))
    const address = this.server.address() as AddressInfo
    this.base = `http://127.0.0.1:${address.port}/`
    return this.base
  }

  /** Stops the server. */
  async stop(): Promise<void> {
    if (this.server === undefined) return
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error === undefined ? resolve() : reject(error)))
    })
    this.server = undefined
  }

  /** Adds an object, as if it had been created on the server. */
  seed(calendarSlug: string, slug: string, ics: string, etag = `"${slug}-1"`): void {
    this.objects.set(`${calendarSlug}/${slug}`, { slug, calendarSlug, ics, etag })
  }

  private expectedAuth(): string {
    return `Basic ${Buffer.from(`${this.account}:${this.secret}`, 'utf8').toString('base64')}`
  }

  private async readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
    return Buffer.concat(chunks).toString('utf8')
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.readBody(request)
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    this.requests.push({
      method: request.method ?? '',
      path,
      depth: request.headers.depth as string | undefined,
      body,
      contentType: request.headers['content-type'] as string | undefined,
    })

    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    if (this.failNext > 0) {
      this.failNext -= 1
      response.writeHead(503, { 'content-type': 'text/plain' })
      response.end('busy')
      return
    }
    if (this.rejectAuth || request.headers.authorization !== this.expectedAuth()) {
      response.writeHead(401, { 'content-type': 'text/plain' })
      response.end('unauthorized')
      return
    }

    const method = request.method ?? 'GET'
    if (method === 'PROPFIND') return this.propfind(path, response)
    if (method === 'REPORT') return this.report(path, body, response)
    if (method === 'PUT') return this.put(path, body, response)
    if (method === 'DELETE') return this.remove(path, response)
    if (method === 'GET') return this.get(path, response)
    response.writeHead(405)
    response.end()
  }

  private propfind(path: string, response: ServerResponse): void {
    const principal = `/${this.principalId}/principal/`
    const home = `/${this.principalId}/calendars/`
    if (path === '/' || path === '') {
      response.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' })
      response.end(
        multistatus([
          `<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>${principal}</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
        ]),
      )
      return
    }
    if (path === principal) {
      response.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' })
      response.end(
        multistatus([
          `<d:response><d:href>${principal}</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>${home}</d:href></c:calendar-home-set><d:displayname>tester</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
        ]),
      )
      return
    }
    if (path === home) {
      const responses = this.calendars.map((calendar) => {
        const components = calendar.components ?? ['VEVENT']
        const privilege = calendar.readOnly === true ? '<d:privilege><d:read/></d:privilege>' : '<d:privilege><d:write/></d:privilege>'
        return (
          `<d:response><d:href>${home}${calendar.slug}/</d:href><d:propstat><d:prop>` +
          '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>' +
          `<d:displayname>${escapeXmlText(calendar.name)}</d:displayname>` +
          `<c:supported-calendar-component-set>${components.map((name) => `<c:comp name="${name}"/>`).join('')}</c:supported-calendar-component-set>` +
          `<d:current-user-privilege-set>${privilege}</d:current-user-privilege-set>` +
          (calendar.color === undefined ? '' : `<x:calendar-color>${calendar.color}</x:calendar-color>`) +
          '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'
        )
      })
      response.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' })
      response.end(multistatus(responses))
      return
    }
    response.writeHead(404)
    response.end()
  }

  private report(path: string, body: string, response: ServerResponse): void {
    const slug = path.replace(/\/$/, '').split('/').pop() ?? ''
    const calendar = this.calendars.find((candidate) => candidate.slug === slug)
    if (calendar === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    const rangeStart = /start="(\d{8}T\d{6}Z)"/.exec(body)?.[1]
    const rangeEnd = /end="(\d{8}T\d{6}Z)"/.exec(body)?.[1]
    const from = rangeStart === undefined ? Number.NEGATIVE_INFINITY : toComparable(rangeStart)
    const to = rangeEnd === undefined ? Number.POSITIVE_INFINITY : toComparable(rangeEnd)
    const responses: string[] = []
    for (const object of this.objects.values()) {
      if (object.calendarSlug !== calendar.slug) continue
      const starts = eventStarts(object.ics)
      const inRange = starts.length === 0 || starts.some((value) => toComparable(value) < to && toComparable(value) + 1000 > from)
      if (!inRange) continue
      responses.push(
        `<d:response><d:href>/${this.principalId}/calendars/${calendar.slug}/${object.slug}</d:href>` +
          `<d:propstat><d:prop><d:getetag>${object.etag}</d:getetag>` +
          `<c:calendar-data>${escapeXmlText(object.ics)}</c:calendar-data>` +
          '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
      )
    }
    response.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' })
    response.end(multistatus(responses))
  }

  private put(path: string, body: string, response: ServerResponse): void {
    const parts = path.replace(/^\//, '').split('/')
    const slug = parts.pop() ?? ''
    const calendarSlug = parts.pop() ?? ''
    if (!this.calendars.some((calendar) => calendar.slug === calendarSlug)) {
      response.writeHead(404)
      response.end()
      return
    }
    const existing = this.objects.get(`${calendarSlug}/${slug}`)
    const etag = `"${slug}-${Date.now()}"`
    this.objects.set(`${calendarSlug}/${slug}`, { slug, calendarSlug, ics: body, etag })
    response.writeHead(existing === undefined ? 201 : 204, { etag })
    response.end()
  }

  private remove(path: string, response: ServerResponse): void {
    const parts = path.replace(/^\//, '').split('/')
    const slug = parts.pop() ?? ''
    const calendarSlug = parts.pop() ?? ''
    const key = `${calendarSlug}/${slug}`
    if (!this.objects.has(key)) {
      response.writeHead(404)
      response.end()
      return
    }
    this.objects.delete(key)
    response.writeHead(204)
    response.end()
  }

  private get(path: string, response: ServerResponse): void {
    const parts = path.replace(/^\//, '').split('/')
    const slug = parts.pop() ?? ''
    const calendarSlug = parts.pop() ?? ''
    const object = this.objects.get(`${calendarSlug}/${slug}`)
    if (object === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', etag: object.etag })
    response.end(object.ics)
  }
}
