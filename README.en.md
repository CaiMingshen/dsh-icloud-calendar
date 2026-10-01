# dsh-icloud-calendar

Read and write your **Apple iCloud Calendar** from **DeepSeek Harness (DSH)** over plain **CalDAV**: list calendars, read a time window (recurring events expanded), create events, and delete behind four gates.

> 中文文档：[README.md](./README.md)

**Status**: compiles, 77 tests green (a DAV-reader suite, an in-process CalDAV server, and a live cordis activation suite; no Apple ID, no network). **Not yet verified end-to-end against a real iCloud account** — run `dsh-icloud-calendar status --probe` first, and test writes against a throwaway calendar.

## Why CalDAV

Apple publishes no REST API for iCloud Calendar, and EventKit is macOS-only. CalDAV (RFC 4791) is the one cross-platform programmatic route:

```
DSH plugin → HTTPS → https://caldav.icloud.com/ → your calendars
Auth: Apple ID (email) + an app-specific password
```

## Install

Requires DSH `>=0.2.0-rc.2` and Node `^22.19 || >=24`.

```bash
dsh plugin --profile web add /absolute/path/dsh-icloud-calendar
dsh plugin --profile web add github:<you>/dsh-icloud-calendar
dsh plugin --profile web add dsh-icloud-calendar          # once published
dsh --profile web --dump-config | Select-String icloud-calendar
```

The bundle inserts two rows: `dsh-icloud-calendar/host` (connection, cache, policy, `ctx.icloudCalendar`) and `dsh-icloud-calendar/tools` (the five model-facing tools). Mount the host alone and the calendar stays usable from code but invisible to the model.

`lib/` is committed on purpose: pnpm ≥10 refuses to run a git dependency's `prepare` script until the user allowlists it, so prebuilt artifacts make a `github:` install work with no build permission and no trust decision.

## Credentials

1. Create an **app-specific password** at <https://appleid.apple.com> (Sign-In and Security → App-Specific Passwords). The Apple ID password is refused once two-factor authentication is on.
2. Store it (first match wins, per `secretSource`):
   - **OS credential store** — DPAPI on Windows, Keychain on macOS, libsecret on Linux;
   - **environment variable** — `secretEnv`, default `ICLOUD_APP_PASSWORD`;
   - `auto` checks the store, then the environment.

```powershell
$p = Read-Host 'app-specific password'
$p | node lib/cli.js login --account you@example.com
```

The secret never enters profile config, tool arguments, session logs, or error messages. On Windows the plaintext is handed to a PowerShell child process on stdin and only the DPAPI blob is written to disk. Keychain is the one backend where the platform tool requires the value as an argument.

Configuration lives in [`examples/cordis.patch.example.yml`](./examples/cordis.patch.example.yml). There is deliberately **no password field**: a profile patch is a file on disk, and storing the secret there would defeat the credential store. Editing config requires reloading the profile (the fields are not `.volatile()`, so no settings form is generated).

## Tools

| Tool | Purpose |
| --- | --- |
| `calendar_status` | Configuration, credential provenance, reachability. Never returns the secret. |
| `calendar_list_calendars` | Calendars with URL, colour, time zone, component types; iCloud Reminders lists report `supportsEvents=false`. |
| `calendar_list_events` | Occurrences in a window, recurring series expanded, cancelled instances skipped, `uid` returned for deletes. |
| `calendar_create_event` | Two dates create an all-day event (exclusive end); two offset-bearing timestamps create a timed event. |
| `calendar_delete_events` | Dry run by default; four gates described below. |

### The four delete gates

1. `allowDeletes` is **false** in a default profile: no delete path exists until it is switched on.
2. A bounded window is mandatory, and the delete window (90 days by default) is smaller than the read window.
3. The target is named exactly — a `uid` or the complete `summaryEquals` title. Substring and fuzzy matches are refused.
4. The call is a **dry run** unless it says `dryRun=false`, and then `confirmCount` must equal the matched object count, capped by `maxDeletesPerCall` (1 by default).

Deleting an occurrence of a recurring series removes the whole series; the result says so.

## CLI

`status`, `login`, `logout`, `calendars`, `events`, `add`, `delete` — see `dsh-icloud-calendar help`. The CLI reuses the same client and the same delete guard, and its `delete` always runs a dry run before requiring `--yes`.

## Measured pitfalls

| # | Pitfall | Handling |
| --- | --- | --- |
| 1 | Apple ID password → HTTP 401 | App-specific password only; `CALENDAR_AUTH_FAILED` says so |
| 2 | ~13 s per fresh CalDAV handshake | One long-lived client per service; serial reads to respect iCloud rate limits |
| 3 | DPAPI via PowerShell costs ~9 s per call (measured) | Resolved once per connection, never per step |
| 4 | Deletes scan whole calendars | A date window is mandatory; no full-collection scan |
| 5 | A fuzzy delete removed eight events once | Exact match, dry run, confirm count, cap of 1 |
| 6 | No deadline → hangs | 30 s deadline, backoff retry on 429/5xx, **never** on 401 |
| 7 | Time zones | Offset-less timestamps are refused; all-day values are read from date fields, not through a local-zone `Date` |
| 8 | Blocked network | `proxyUrl` (needs the optional `undici`) |
| 9 | Hot reload | New bundles may activate via HMR; replacing an installed package needs a restart |
| 10 | Reminders lists | Skipped as event calendars; naming one is an explicit error |

## Development

```bash
pnpm install
pnpm typecheck
pnpm test      # 77 tests: DAV reader, in-process CalDAV mock (401 / 503 / timeout), live cordis activation
pnpm build     # tsc → lib/
```

Beyond the unit suites, two live checks were run: the bundle was installed into a throwaway profile and its layer appeared in `dsh --profile <probe> --dump-config`, and that profile was booted for real — it reached the model call in 2.2 s and stopped only on the missing LLM credential, with no plugin row failing. A falsification run backs that up: pointing one row at a non-existent module makes the same boot hang in composition instead of proceeding, so "it got to the model call" really does mean both rows activated.

## License

MIT. Independently implemented; the design was informed by [`moziforge/calendar-plugins`](https://github.com/moziforge/calendar-plugins) (Apache-2.0) and [`STARDUSTLC666/dsh-calendar`](https://github.com/STARDUSTLC666/dsh-calendar) (MIT).
