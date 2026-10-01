#!/usr/bin/env node
/**
 * Standalone CLI.
 *
 * Why it exists: credentials and connectivity are the two things that go wrong
 * first, and debugging them through an agent conversation is slow. This entry
 * point reuses the exact same client, credential store and delete guard as the
 * plugin, so `status` and `calendars` prove the profile will work before the
 * model ever calls a tool.
 *
 * It is also the answer to the measured "13 seconds per call" problem: one
 * process serves one command and keeps its connection for the duration, so put
 * several operations in one invocation (or use the plugin, whose service keeps
 * the connection for the whole session) instead of scripting many short runs.
 */

import { CalendarError, toCalendarError } from './errors.js'
import { ICloudCalendarClient } from './client.js'
import {
  DEFAULT_CONFIG,
  assertStoreKind,
  describeConfiguration,
  resolveConfig,
  resolveCredentials,
  storeFor,
  type Config,
} from './config.js'
import type { SecureStore } from './credentials.js'
import { resolveWindow } from './ical.js'
import { runDelete } from './policy.js'
import type { CalendarSummary } from './types.js'

const DAY_MS = 86_400_000

interface ParsedArgs {
  command: string
  flags: Map<string, string | true>
  positional: string[]
}

const BOOLEAN_FLAGS = new Set(['json', 'yes', 'force', 'help', 'probe', 'dry-run'])

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? ''
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const body = token.slice(2)
    const equals = body.indexOf('=')
    if (equals !== -1) {
      flags.set(body.slice(0, equals), body.slice(equals + 1))
      continue
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags.set(body, true)
      continue
    }
    const next = rest[index + 1]
    if (next === undefined || next.startsWith('--')) {
      flags.set(body, true)
      continue
    }
    flags.set(body, next)
    index += 1
  }
  return { command, flags, positional }
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

function booleanFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true
}

function requireFlag(args: ParsedArgs, name: string, hint: string): string {
  const value = stringFlag(args, name)
  if (value === undefined || value === '') {
    throw new CalendarError('CALENDAR_INVALID_INPUT', `--${name} is required: ${hint}`)
  }
  return value
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8').trim()
}

/** Configuration from environment plus the few flags that shape it. */
function configFrom(args: ParsedArgs): Config {
  const overrides: Partial<Config> = {}
  const account = stringFlag(args, 'account')
  if (account !== undefined) overrides.account = account
  const storeKind = stringFlag(args, 'store')
  if (storeKind !== undefined) overrides.storeKind = assertStoreKind(storeKind)
  const directory = stringFlag(args, 'store-directory')
  if (directory !== undefined) overrides.storeDirectory = directory
  const proxy = stringFlag(args, 'proxy')
  if (proxy !== undefined) overrides.proxyUrl = proxy
  const timeout = stringFlag(args, 'timeout-ms')
  if (timeout !== undefined) overrides.timeoutMs = Number.parseInt(timeout, 10)
  const server = stringFlag(args, 'server')
  if (server !== undefined) overrides.serverUrl = server
  if (booleanFlag(args, 'allow-deletes')) overrides.allowDeletes = true
  const maxDeletes = stringFlag(args, 'max-deletes')
  if (maxDeletes !== undefined) overrides.maxDeletesPerCall = Number.parseInt(maxDeletes, 10)
  const maxWindowDays = stringFlag(args, 'max-window-days')
  if (maxWindowDays !== undefined) overrides.maxWindowDays = Number.parseInt(maxWindowDays, 10)
  return resolveConfig(overrides)
}

function print(value: unknown, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    return
  }
  if (typeof value === 'string') {
    process.stdout.write(`${value}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function formatCalendars(calendars: readonly CalendarSummary[]): string {
  if (calendars.length === 0) return 'No calendars found.'
  const lines = ['NAME                 EVENTS  READ-ONLY  URL']
  for (const calendar of calendars) {
    lines.push(
      `${calendar.name.padEnd(20).slice(0, 20)} ${(calendar.supportsEvents ? 'yes' : 'no').padEnd(7)} ` +
        `${(calendar.readOnly ? 'yes' : 'no').padEnd(10)} ${calendar.url}`,
    )
  }
  return lines.join('\n')
}

async function withClient<T>(
  config: Config,
  store: SecureStore,
  run: (client: ICloudCalendarClient) => Promise<T>,
): Promise<T> {
  const resolved = await resolveCredentials(config, store)
  const client = await ICloudCalendarClient.connect({
    credentials: resolved.credentials,
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    proxyUrl: config.proxyUrl,
    maxOccurrencesPerSeries: config.maxOccurrencesPerSeries,
  })
  return await run(client)
}

const HELP = `dsh-icloud-calendar â€?iCloud Calendar over CalDAV for DeepSeek Harness

Usage: dsh-icloud-calendar <command> [flags]

Commands
  status                Show configuration, credential source and readiness
  login                 Store the app-specific password in the OS credential store
  logout                Remove the stored password
  calendars             List calendars
  events                List event occurrences in a window
  add                   Create one event
  delete                Delete events (dry run unless --dry-run=false --yes)

Common flags
  --account <apple-id>       Apple ID email (default: $ICLOUD_ACCOUNT)
  --store <auto|dpapi|keychain|secret-tool|none>
  --store-directory <path>   Where the DPAPI blob lives (Windows)
  --proxy <url>              HTTP proxy for CalDAV and token traffic
  --timeout-ms <n>           Per-request deadline (default 30000)
  --server <url>             CalDAV endpoint (default https://caldav.icloud.com/)
  --json                     Machine-readable output

Window flags (events, delete)
  --start <when> --end <when>    RFC3339 with offset, or YYYY-MM-DD for all-day

add flags
  --summary <title> [--calendar <name>] [--location <text>] [--description <text>]
  [--time-zone <IANA>]

delete flags
  --uid <uid> | --summary-equals <exact title>   (exact match only)
  [--calendar <name>] [--max-deletes <n>] [--dry-run=false] [--yes]

Examples
  dsh-icloud-calendar status --json
  $p = Read-Host 'app-specific password'; $p | dsh-icloud-calendar login --account you@example.com
  dsh-icloud-calendar events --start 2026-01-05T00:00:00+08:00 --end 2026-01-12T00:00:00+08:00
`

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.command === 'help' || booleanFlag(args, 'help')) {
    print(HELP, false)
    return 0
  }
  const asJson = booleanFlag(args, 'json')
  const config = configFrom(args)

  switch (args.command) {
    case 'status': {
      const store = storeFor(config)
      const description = describeConfiguration(config, store)
      let secretSource: string | null = null
      let problem: string | null = null
      try {
        const resolved = await resolveCredentials(config, store)
        secretSource = resolved.source
      } catch (error) {
        problem = toCalendarError(error).message
      }
      const status = { configuration: description, secretSource, problem }
      if (booleanFlag(args, 'probe') && problem === null) {
        const calendars = await withClient(config, store, async (client) =>
          await client.listCalendars({ force: true }),
        )
        print({ ...status, connected: true, calendarCount: calendars.length, calendars: calendars.map((c) => c.name) }, asJson)
        return 0
      }
      if (asJson) {
        print(status, true)
        return problem === null ? 0 : 1
      }
      const lines = [
        `account          ${description.account ?? '(not configured)'}`,
        `server           ${description.serverUrl}`,
        `password source  ${secretSource ?? `(none; looked for ${description.secretEnvVar} and the ${description.store.kind} store)`}`,
        `store            ${description.store.kind}${description.store.location === null ? '' : ` (${description.store.location})`}`,
        `writes           ${description.writesAllowed ? 'allowed' : 'disabled'}`,
        `deletes          ${description.deletesAllowed ? 'allowed' : 'disabled (set allowDeletes to enable)'}`,
        `timeout / retry  ${description.timeoutMs} ms / ${description.retries}`,
        `proxy            ${description.proxyConfigured ? 'configured' : 'none'}`,
        `window cap       ${description.maxWindowDays} days read, ${description.maxDeleteWindowDays} days delete`,
      ]
      if (problem !== null) lines.push('', `problem          ${problem}`)
      print(lines.join('\n'), false)
      return problem === null ? 0 : 1
    }

    case 'login': {
      const store = storeFor(config)
      const description = describeConfiguration(config, store)
      if (description.account === null) {
        throw new CalendarError('CALENDAR_INVALID_INPUT', 'Pass --account you@example.com (or export ICLOUD_ACCOUNT) to log in.')
      }
      const fromEnv = stringFlag(args, 'secret-env')
      const secret = fromEnv === undefined ? await readStdin() : (process.env[fromEnv] ?? '')
      if (secret === '') {
        throw new CalendarError(
          'CALENDAR_INVALID_INPUT',
          'No secret arrived on stdin. Pipe the app-specific password in, for example: ' +
            "Get-Content secret.txt | dsh-icloud-calendar login --account you@example.com",
        )
      }
      await store.set(description.account, secret)
      print(
        asJson
          ? { account: description.account, store: store.description }
          : `Stored the app-specific password for ${description.account} in ${store.description.kind}` +
            `${store.description.location === null ? '' : ` (${store.description.location})`}.`,
        asJson,
      )
      return 0
    }

    case 'logout': {
      const store = storeFor(config)
      const description = describeConfiguration(config, store)
      if (description.account === null) {
        throw new CalendarError('CALENDAR_INVALID_INPUT', 'Pass --account you@example.com (or export ICLOUD_ACCOUNT) to log out.')
      }
      const removed = await store.remove(description.account)
      print(removed ? `Removed the stored secret for ${description.account}.` : 'Nothing was stored for that account.', asJson)
      return 0
    }

    case 'calendars': {
      const store = storeFor(config)
      const calendars = await withClient(config, store, async (client) => await client.listCalendars({ force: true }))
      print(asJson ? calendars : formatCalendars(calendars), asJson)
      return 0
    }

    case 'events': {
      const store = storeFor(config)
      const start = requireFlag(args, 'start', 'inclusive window start')
      const end = requireFlag(args, 'end', 'exclusive window end')
      const limit = stringFlag(args, 'limit')
      const calendar = stringFlag(args, 'calendar')
      const result = await withClient(config, store, async (client) => {
        const window = resolveWindow(start, end, config.maxWindowDays * DAY_MS)
        const all = await client.listCalendars({})
        const selected =
          calendar === undefined ? all.filter((entry) => entry.supportsEvents) : [client.resolveCalendar(all, calendar)]
        return await client.listEvents(window, {
          calendars: selected,
          ...(limit === undefined ? {} : { limit: Number.parseInt(limit, 10) }),
        })
      })
      if (asJson) {
        print(result, true)
        return 0
      }
      const lines = [`${result.total} occurrence(s) in ${result.window.start} .. ${result.window.end}`]
      for (const event of result.events) {
        lines.push(
          `${event.start}  ${event.allDay ? '[all-day] ' : ''}${event.summary}` +
            `  (${event.calendar.name})${event.location === undefined ? '' : ` @ ${event.location}`}`,
        )
        lines.push(`    uid ${event.uid}`)
      }
      if (result.truncatedSeries.length > 0) {
        lines.push(`truncated series: ${result.truncatedSeries.join(', ')}`)
      }
      print(lines.join('\n'), false)
      return 0
    }

    case 'add': {
      const store = storeFor(config)
      const summary = requireFlag(args, 'summary', 'event title')
      const start = requireFlag(args, 'start', 'event start')
      const end = requireFlag(args, 'end', 'event end')
      const calendar = stringFlag(args, 'calendar')
      const location = stringFlag(args, 'location')
      const description = stringFlag(args, 'description')
      const timeZone = stringFlag(args, 'time-zone')
      const created = await withClient(config, store, async (client) => {
        const all = await client.listCalendars({})
        const target = client.resolveCalendar(all, calendar)
        return await client.createEvent(target, {
          summary,
          start,
          end,
          ...(location === undefined ? {} : { location }),
          ...(description === undefined ? {} : { description }),
          ...(timeZone === undefined ? {} : { timeZone }),
        })
      })
      print(
        asJson ? created : `Created "${created.summary}" in ${created.calendar.name} (${created.start} .. ${created.end})\n  ${created.url}`,
        asJson,
      )
      return 0
    }

    case 'delete': {
      const store = storeFor(config)
      const start = requireFlag(args, 'start', 'inclusive window start')
      const end = requireFlag(args, 'end', 'exclusive window end')
      const uid = stringFlag(args, 'uid')
      const summaryEquals = stringFlag(args, 'summary-equals')
      const calendar = stringFlag(args, 'calendar')
      const maxDeletes = stringFlag(args, 'max-deletes')
      const confirmed = booleanFlag(args, 'yes')
      const dryRunFlag = args.flags.get('dry-run')
      const dryRun = dryRunFlag === undefined ? true : dryRunFlag !== 'false'
      const result = await withClient(config, store, async (client) => {
        const selectCalendars = async (requested: readonly string[] | undefined): Promise<CalendarSummary[]> => {
          const all = await client.listCalendars({})
          const names = requested !== undefined && requested.length > 0 ? requested : config.defaultCalendars
          if (names.length === 0) return all.filter((entry) => entry.supportsEvents)
          return names.map((entry) => client.resolveCalendar(all, entry))
        }
        const deps = {
          config,
          selectCalendars,
          listEvents: async (options: { start: string; end: string; calendars?: readonly string[]; limit?: number }) => {
            const window = resolveWindow(options.start, options.end, config.maxWindowDays * DAY_MS)
            const selected = await selectCalendars(options.calendars)
            return await client.listEvents(window, {
              calendars: selected,
              ...(options.limit === undefined ? {} : { limit: options.limit }),
            })
          },
          deleteObject: async (url: string, etag: string | undefined) => await client.deleteObject(url, etag),
        }
        const request = {
          start,
          end,
          ...(uid === undefined ? {} : { uid }),
          ...(summaryEquals === undefined ? {} : { summaryEquals }),
          ...(calendar === undefined ? {} : { calendar }),
          ...(maxDeletes === undefined ? {} : { maxDeletes: Number.parseInt(maxDeletes, 10) }),
        }
        // The CLI always runs the guard's dry run first: it is what produces the
        // object count the real delete has to confirm, so `--yes` alone can
        // never delete something nobody looked at.
        const preview = await runDelete(deps, { ...request, dryRun: true })
        if (dryRun) return preview
        if (!confirmed) {
          throw new CalendarError(
            'CALENDAR_UNSAFE_DELETE',
            `Refusing to delete ${preview.count} object(s) without --yes. Review the dry run above, then repeat with --dry-run=false --yes.`,
          )
        }
        if (preview.count === 0) return preview
        return await runDelete(deps, { ...request, dryRun: false, confirmCount: preview.count })
      })
      print(
        asJson
          ? result
          : [
              `${result.dryRun ? 'DRY RUN' : 'DELETED'} â€?${result.count} object(s)`,
              ...result.matched.map((event) => `  ${event.start}  ${event.summary}  (${event.calendar.name}) ${event.url}`),
              ...result.notes.map((note) => `note: ${note}`),
            ].join('\n'),
        asJson,
      )
      return 0
    }

    default:
      print(`Unknown command "${args.command}".\n\n${HELP}`, false)
      return 2
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    const normalized = toCalendarError(error)
    process.stderr.write(`${normalized.code}: ${normalized.message}\n`)
    process.exitCode = 1
  })

export { DEFAULT_CONFIG }
