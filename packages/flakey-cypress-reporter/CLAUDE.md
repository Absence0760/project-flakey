# @flakeytesting/cypress-reporter

Cypress reporter + plugin + support bundle. Uploads results, screenshots, videos, and DOM snapshots to the Flakey backend.

## Commands

- `pnpm build` — `tsc` **and** `node scripts/build-cjs.cjs`. The reporter entry is published as CommonJS (`dist/reporter.cjs`) because Cypress's Mocha reporter interface loads via `require`; the plugin and support files are ESM. If you add a new entry point, mirror the convention.

## Entry points

From `package.json` `exports`:

- `.` → `dist/reporter.cjs` — Mocha-style reporter for `reporterOptions`
- `./plugin` → `dist/plugin.js` — `setupNodeEvents` wiring (screenshots/videos/upload)
- `./support` → `dist/support.js` — browser-side hooks

Both `flakeyReporter` and `setupFlakey` are exported from `./plugin`.

- `flakeyReporter(on, config, options?)` — registers upload hooks only.
- `setupFlakey(on, config, opts?)` — composes `flakeyReporter` + optional `@flakeytesting/cypress-snapshots` + optional `@flakeytesting/live-reporter`. **Prefer this in consumer configs.**

`SetupFlakeyOptions`: `{ snapshots?: boolean, live?: boolean, reporterOptions?: FlakeyReporterOptions }`

The integration examples (`examples/cypress/cypress.config.ts`) use `setupFlakey`. Use `flakeyReporter` directly only when you want to opt out of snapshots and live streaming.

## Peer deps

- `cypress >=12.0.0` (required)
- `@flakeytesting/cypress-snapshots >=0.1.0` (optional — enables DOM snapshot capture)
- `@flakeytesting/live-reporter >=0.1.0` (optional — enables live-event streaming)

Don't promote the optional peers to required; users should be able to use the reporter without snapshots or live events.

## Per-test screenshot streaming

The plugin registers `on("after:screenshot", ...)`: each PNG is POSTed to `/live/:runId/screenshot` the moment Cypress writes it, with the spec path and full test title attached so the backend can link it directly to `tests.screenshot_paths` (no fragile filename matching).

**On 2xx the local file is `unlinkSync`ed.** Mirrors the `flakey-cypress-snapshots` pattern, for the same reason: a long suite that takes hundreds of failure screenshots can otherwise fill a CI runner's disk before `after:run` ever fires. The `after:run` batch's `findFiles(screenshotsDir, [".png"])` walks the dir at end-of-run, so a deleted file is naturally absent from the batch — no separate `Set<string>` is needed for dedup. On streaming failure (no live run id, network blip, non-2xx response), the file is left in place and the batch path picks it up unchanged.

If a consumer needs the local screenshots preserved for their own debugging, they should disable streaming (don't use `setupFlakey` or `flakeyReporter`'s `after:screenshot` registration) — the unlink is the contract of the streaming path.

The end-of-run merge (both `/runs` and `/runs/upload`) preserves the streamed `screenshot_paths` and `snapshot_path` across the test delete+reinsert by snapshotting them before the `DELETE` and unioning them with whatever the upload payload supplies.

## Environment label

`reporterOptions.environment` (third-arg or via `setupFlakey`) takes precedence; otherwise the reporter resolves it lazily at upload time, walking `process.env.FLAKEY_ENV` → `process.env.TEST_ENV` → `config.env.environment` → `config.env.name`. The last two cover Cypress's own `cypress run --env environment=qa` / `--env name=qa` conventions. Whichever resolves first lands on the run as `meta.environment`. Resolution is lazy because `setupNodeEvents` merges `--env` after the plugin registers — capturing at registration would always see the empty value.

## Depends on

- `@flakeytesting/core` (workspace) — shared upload/format helpers.

## Live run id resolution (process-tree walk)

The Mocha reporter runs in a **different Node process** from `setupNodeEvents`. In Cypress 15+, the reporter's process isn't even a direct child of the plugin — there's an intermediate Cypress process between them, so `process.ppid` in the reporter does NOT equal the plugin's `process.pid`. Matching by a single PID isn't reliable.

Instead, both sides walk their own process-ancestry chain:

- **Plugin** (`src/plugin.ts`, runs in setupNodeEvents' process): on `/live/start` success, writes `$TMPDIR/flakey-reporter/live-run-id-<pid>` for every pid in its ancestor chain (self → parent → grandparent → …, up to 12 levels or pid 1). `@flakeytesting/live-reporter`'s `mocha.ts` does the actual writing via `register()`; it also cleans them up in `after:run`.
- **Mocha reporter** (`src/reporter.ts`): `readLiveRunId()` walks its own ancestor chain and reads the first `live-run-id-<pid>` file that exists. The nearest shared ancestor wins — usually the cypress-CLI pid, which sits above both the plugin process and the reporter's process tree branch.

Ancestor PIDs are resolved via `execSync("ps -o ppid= -p <pid>")` (macOS + Linux). The walk stops at pid 1 or on any `ps` error.

Resolution order inside `readLiveRunId()`:

1. `process.env.FLAKEY_LIVE_RUN_ID` — fast path if cypress propagates env to the reporter (rare; Cypress 15+ does not).
2. `$TMPDIR/flakey-reporter/live-run-id-<ancestor-pid>` for each ancestor in the walk.

If you see tests running but no per-test events or no `/runs` upload in the dashboard, run both processes with `[flakey-diag]` logs enabled and confirm the reporter's ancestor chain contains a pid the plugin wrote. Usually it does; if it doesn't, the plugin's ancestry walk needs to go deeper (bump `maxDepth`) or the user's Cypress setup is non-standard (ask them to share their config).

**Concurrency safety.** Two concurrent `cypress run` invocations have distinct cypress-CLI pids. Each plugin writes files under its own cypress-CLI pid (and its own children), and each reporter finds only its own cypress-CLI pid in its ancestor walk, so they never collide — no shared tmpfile, no `TMPDIR` workaround.

## Spec buffer directory (live-run-id scoped)

The Mocha reporter writes per-spec result buffers to a temp directory that the plugin's `after:run` drains for the final `/runs` upload. Buffer dirs are scoped by the **numeric live-run-id** (not PID), so both sides converge on the same path via the run-id handoff file described above:

- Plugin: `$TMPDIR/flakey-reporter/run-<liveRunId>/` and `$TMPDIR/flakey-commands/run-<liveRunId>/`.
- Mocha reporter: `$TMPDIR/flakey-reporter/run-<liveRunId>/`.

Since live-run-ids are unique per `/live/start` call, concurrent invocations never share a buffer dir. Stale dirs from crashed runs age out naturally; the plugin's `before:run` is a no-op (cleanup happens in `after:run` after draining).
