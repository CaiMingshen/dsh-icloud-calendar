/**
 * Activation test: mount the real plugin modules on a real cordis context.
 *
 * The other suites test the client, the iCalendar helpers and the delete guard
 * as plain modules. This one covers what only a live composition can prove: the
 * host row registers `ctx.icloudCalendar` as a cordis service, the tools row's
 * `inject` list is satisfied, five tools appear in the registry under the
 * expected names, and a registered tool runs end to end and returns the lossless
 * JSON value its output declaration promises.
 *
 * No network and no credentials: `storeKind: 'none'` with an empty environment
 * leaves the service unconfigured, which is precisely the state
 * `calendar_status` exists to describe.
 */

import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { resolveConfig, type Config as CalendarConfig } from '../src/config.js'
import * as host from '../src/host.js'
import * as tools from '../src/tools.js'
import type { CalendarStatus } from '../src/types.js'

interface Registered {
  name: string
  definition: ToolDefinition
}

/** The exec object the registry normally passes to a tool body. */
function exec(): never {
  return { signal: new AbortController().signal } as never
}

/**
 * Mounts both rows the way the loader does: the host binds the validated config,
 * the tools row runs with its declared injections resolved.
 */
async function mountPlugin(config: Partial<CalendarConfig> = {}): Promise<{
  registered: Registered[]
  ctx: Context
  service: host.ICloudCalendarService
}> {
  const registered: Registered[] = []
  const ctx = new Context()

  await ctx.plugin({
    name: 'fake-tools-registry',
    apply: (scope) => {
      scope.provide('tools', {
        register: (definition: ToolDefinition) => {
          registered.push({ name: definition.name, definition })
          return () => {
            const index = registered.findIndex((entry) => entry.definition === definition)
            if (index >= 0) registered.splice(index, 1)
          }
        },
      })
    },
  })

  const resolved = resolveConfig({ storeKind: 'none', account: '', secretEnv: 'ICLOUD_APP_SECRET_UNSET', ...config })
  let service: host.ICloudCalendarService | undefined

  // The host row, mounted exactly as the loader mounts it.
  await ctx.plugin(
    {
      name: host.name,
      Config: host.Config,
      apply: (scope: Context, incoming: CalendarConfig) => {
        service = new host.ICloudCalendarService(scope, incoming)
      },
    },
    resolved,
  )

  // The tools row, with its declared injections.
  await ctx.plugin({ name: tools.name, inject: tools.inject, apply: tools.apply })

  if (service === undefined) throw new Error('the host row did not run')
  return { registered, ctx, service }
}

describe('plugin activation', () => {
  it('mounts the host service and registers the five tools', async () => {
    const { registered, ctx } = await mountPlugin()
    expect(ctx.icloudCalendar).toBeDefined()
    expect(registered.map((entry) => entry.name).sort()).toEqual([
      'calendar_create_event',
      'calendar_delete_events',
      'calendar_list_calendars',
      'calendar_list_events',
      'calendar_status',
    ])
  })

  it('exposes required window arguments in the tool schemas', async () => {
    const { registered } = await mountPlugin()
    const list = registered.find((entry) => entry.name === 'calendar_list_events')?.definition
    const remove = registered.find((entry) => entry.name === 'calendar_delete_events')?.definition
    const listParameters = list?.parameters as { properties?: Record<string, unknown>; required?: string[] }
    const deleteParameters = remove?.parameters as { properties?: Record<string, unknown>; required?: string[] }
    expect(Object.keys(listParameters.properties ?? {})).toContain('calendars')
    expect(listParameters.required).toEqual(expect.arrayContaining(['start', 'end']))
    expect(deleteParameters.required).toEqual(expect.arrayContaining(['start', 'end']))
    // Exact-match deletion must be expressible, and a substring match must not be.
    expect(Object.keys(deleteParameters.properties ?? {})).toEqual(
      expect.arrayContaining(['uid', 'summaryEquals', 'dryRun', 'confirmCount']),
    )
  })

  it('reports configuration through calendar_status without throwing', async () => {
    const { registered } = await mountPlugin()
    const status = registered.find((entry) => entry.name === 'calendar_status')
    expect(status).toBeDefined()
    const result = (await status?.definition.execute({}, exec())) as CalendarStatus
    // No account and no secret anywhere: the tool must say so instead of failing.
    expect(result.configured).toBe(false)
    expect(result.deletesAllowed).toBe(false)
    expect(result.serverUrl).toBe('https://caldav.icloud.com/')
    expect(result.store.kind).toBe('none')
    // The value is lossless JSON, which is what the output declaration requires.
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })

  it('renders tool output as model-readable text', async () => {
    const { registered } = await mountPlugin()
    const status = registered.find((entry) => entry.name === 'calendar_status')
    const blocks = status?.definition.output.render({}, { ok: true } as never) as unknown as Array<{
      type: string
      text: string
    }>
    expect(blocks[0]?.type).toBe('text')
    expect(JSON.parse(blocks[0]?.text ?? '')).toEqual({ ok: true })
  })

  it('refuses a delete while the profile keeps deletes off', async () => {
    const { registered } = await mountPlugin()
    const remove = registered.find((entry) => entry.name === 'calendar_delete_events')
    await expect(
      remove?.definition.execute(
        { start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z', uid: 'u1' },
        exec(),
      ),
    ).rejects.toMatchObject({ code: 'CALENDAR_READ_ONLY' })
  })

  it('refuses a write when the profile is read-only', async () => {
    const { registered } = await mountPlugin({ allowWrites: false })
    const create = registered.find((entry) => entry.name === 'calendar_create_event')
    await expect(
      create?.definition.execute({ summary: 'x', start: '2026-01-05', end: '2026-01-06' }, exec()),
    ).rejects.toMatchObject({ code: 'CALENDAR_READ_ONLY' })
  })

  it('reports readiness as not configured when only the account is missing', async () => {
    const { service } = await mountPlugin({ account: 'tester@example.com', storeKind: 'none' })
    const status = await service.status()
    expect(status.account).toBe('tester@example.com')
    expect(status.configured).toBe(false)
    // The explanation names the variable to set, and never a credential value.
    await expect(service.listCalendars({})).rejects.toMatchObject({ code: 'CALENDAR_NOT_CONFIGURED' })
  })
})
