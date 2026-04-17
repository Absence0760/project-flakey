# @flakeytesting/cypress-reporter

Cypress reporter + plugin + support bundle. Uploads results, screenshots, videos, and DOM snapshots to the Flakey backend.

## Commands

- `pnpm build` — `tsc` **and** `node scripts/build-cjs.cjs`. The reporter entry is published as CommonJS (`dist/reporter.cjs`) because Cypress's Mocha reporter interface loads via `require`; the plugin and support files are ESM. If you add a new entry point, mirror the convention.

## Entry points

From `package.json` `exports`:

- `.` → `dist/reporter.cjs` — Mocha-style reporter for `reporterOptions`
- `./plugin` → `dist/plugin.js` — `setupNodeEvents` wiring (screenshots/videos/upload)
- `./support` → `dist/support.js` — browser-side hooks

## Peer deps

- `cypress >=12.0.0` (required)
- `@flakeytesting/cypress-snapshots >=0.1.0` (optional — enables DOM snapshot capture)
- `@flakeytesting/live-reporter >=0.1.0` (optional — enables live-event streaming)

Don't promote the optional peers to required; users should be able to use the reporter without snapshots or live events.

## Depends on

- `@flakeytesting/core` (workspace) — shared upload/format helpers.

## Live run id resolution

The Mocha reporter runs in a separate Node process from `setupNodeEvents` and does not inherit env mutations set during plugin registration. `readLiveRunId()` in `src/reporter.ts` therefore checks sources in order:

1. `process.env.FLAKEY_LIVE_RUN_ID` — fast path when the reporter is launched in the same process or env was explicitly propagated.
2. `$TMPDIR/flakey-reporter/live-run-id-<process.ppid>` — the PID-scoped file written by `@flakeytesting/live-reporter`'s `register()`. The reporter's parent is the main Cypress process, which is also the PID live-reporter uses when writing the file, so both sides resolve to the same path.
3. `$TMPDIR/flakey-reporter/live-run-id` — legacy un-scoped path, retained for back-compat with older live-reporter builds.

Sources must resolve to the same numeric id for per-test live events (`test.started` / `test.passed` / `test.failed` / `test.skipped`) to stream correctly. If you see tests running but no per-test events in the dashboard, check that the resolver is picking up the right file. The PID scoping also lets two concurrent `cypress run` invocations on the same machine coexist without overwriting each other's run ids.

## Spec buffer directory (concurrent runs)

The Mocha reporter writes per-spec result buffers to a temp directory that the plugin's `after:run` drains for the final `/runs` upload. To prevent concurrent `cypress run` invocations on the same machine from stomping each other's buffers (and causing the loser's upload to find an empty directory), the buffer dir is scoped by the main Cypress process's PID:

- Plugin (`src/plugin.ts`, in the main Cypress process): `$TMPDIR/flakey-reporter/run-<process.pid>/` and `$TMPDIR/flakey-commands/run-<process.pid>/`.
- Mocha reporter (`src/reporter.ts`, child process): `$TMPDIR/flakey-reporter/run-<process.ppid>/`.

Both sides agree on the same main-Cypress PID. The `live-run-id-<pid>` hand-off file stays in the un-scoped `$TMPDIR/flakey-reporter/` base dir (it's already PID-scoped by filename).
