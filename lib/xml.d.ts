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
/** Expands the five predefined XML entities plus numeric character references. */
export declare function decodeEntities(value: string): string;
interface TagMatch {
    /** Raw attributes text of the opening tag. */
    attributes: string;
    /** Raw inner text between the opening and matching closing tag. */
    inner: string;
}
/**
 * Returns the first element whose local name is `localName`, whatever prefix it
 * carries. Nested elements with the same name are not considered: the match is
 * the first opening tag and the first closing tag after it.
 */
export declare function firstTag(xml: string, localName: string): TagMatch | undefined;
/** All elements with the given local name, in document order, non-nested. */
export declare function allTags(xml: string, localName: string): TagMatch[];
/** Decoded text of the first matching element, or undefined when absent. */
export declare function tagText(xml: string, localName: string): string | undefined;
/** Raw (still entity-encoded) inner text — for `calendar-data`, which is CDATA-ish. */
export declare function tagRaw(xml: string, localName: string): string | undefined;
/** Whether an element with this local name occurs anywhere in the fragment. */
export declare function hasTag(xml: string, localName: string): boolean;
/** One `<response>` block from a multistatus body. */
export interface DavResponse {
    href: string;
    /** Numeric status of the propstat that carried the properties. */
    status: number | undefined;
    /** The matching `<prop>` fragment, empty when the reply had none. */
    props: string;
    /** Response-level status, used by some servers instead of propstat. */
    responseStatus: number | undefined;
}
/** Parses a `207 Multistatus` body into its response blocks. */
export declare function parseMultistatus(xml: string): DavResponse[];
/** Extracts the numeric status from a `HTTP/1.1 200 OK` status line. */
export declare function parseStatusLine(value: string | undefined): number | undefined;
/**
 * Resolves an href from a multistatus reply against the request URL.
 *
 * A value that is empty, or that still carries markup or whitespace, is handed
 * back unchanged: `new URL()` would happily percent-encode such input into a
 * syntactically valid request for something the server never meant, and a
 * visible bogus URL in an error is more useful than a silent 404 elsewhere.
 */
export declare function resolveHref(href: string, base: string): string;
/** Escapes text for inclusion in an XML body or an iCalendar property. */
export declare function escapeXml(value: string): string;
/** WebDAV/CalDAV request bodies this client sends. */
export declare const DAV_BODIES: {
    readonly currentUserPrincipal: "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<d:propfind xmlns:d=\"DAV:\">\n  <d:prop>\n    <d:current-user-principal/>\n  </d:prop>\n</d:propfind>";
    readonly calendarHome: "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<d:propfind xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\">\n  <d:prop>\n    <c:calendar-home-set/>\n    <d:displayname/>\n  </d:prop>\n</d:propfind>";
    readonly calendars: "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<d:propfind xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\" xmlns:cs=\"http://calendarserver.org/ns/\">\n  <d:prop>\n    <d:resourcetype/>\n    <d:displayname/>\n    <d:current-user-privilege-set/>\n    <c:supported-calendar-component-set/>\n    <c:calendar-timezone/>\n    <cs:getctag/>\n    <x:calendar-color xmlns:x=\"http://apple.com/ns/ical/\"/>\n  </d:prop>\n</d:propfind>";
    /** One calendar-query limited to a time range; the shallow report we rely on. */
    readonly calendarQuery: (start: string, end: string) => string;
    /** Direct object fetch, used to re-read one event before a mutation. */
    readonly calendarObject: "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<c:calendar-query xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\">\n  <d:prop>\n    <d:getetag/>\n    <c:calendar-data/>\n  </d:prop>\n  <c:filter>\n    <c:comp-filter name=\"VCALENDAR\">\n      <c:comp-filter name=\"VEVENT\"/>\n    </c:comp-filter>\n  </c:filter>\n</c:calendar-query>";
};
export {};
