# @flakeytesting/live-reporter

Lightweight framework-agnostic adapters that stream live test events (start/pass/fail) to the Flakey backend in real time.

## Commands

- `pnpm build` — `tsc` → `dist/`

## Entry points

One subpath per supported framework:

- `.` → generic event emitter / transport
- `./playwright` — Playwright reporter adapter
- `./mocha` — Mocha reporter adapter (used inside Cypress)
- `./webdriverio` — WebdriverIO reporter adapter

When adding a framework, follow the existing shape: emit normalized events through the shared transport in `dist/index.js`, don't re-implement the transport per adapter.

## Env vars (inputs)

All three adapters (mocha, playwright, webdriverio) read these from `process.env` as fallbacks when the matching `config.*` field is absent:

| Var | Adapters | Notes |
|-----|----------|-------|
| `FLAKEY_API_URL` | all | Base URL; overridden by `config.url` |
| `FLAKEY_API_KEY` | all | Auth token; overridden by `config.apiKey` |
| `FLAKEY_SUITE` | all | Suite name fallback; overridden by `config.suite` |
| `FLAKEY_LIVE_RUN_ID` | all | Pre-set run id; skips `/live/start` call when set |
| `BRANCH` / `GITHUB_HEAD_REF` / `GITHUB_REF_NAME` | all | Branch fallback chain |
| `COMMIT_SHA` / `GITHUB_SHA` | all | Commit SHA fallback chain |
| `CI_RUN_ID` / `GITHUB_RUN_ID` | all | CI run id fallback; `mocha.ts` also writes this after `/live/start` |
| `FLAKEY_ENV` / `TEST_ENV` | mocha | Target environment label (e.g. "qa", "stage"); forwarded to `/live/start` as `environment` so the placeholder run records it up front |

## Heartbeat

`LiveClient` ticks an `unref`'d 30s interval that calls `flush({ allowEmpty: true })` — even with an empty queue the request POSTs `[]` so the backend's `/live/:runId/events` handler updates `lastEventAt` via `LiveEventBus.touch()`. This stops the stale-run detector (default 10-minute timeout) from auto-aborting a still-running suite during long quiet stretches (a slow Cucumber scenario, large `cy.wait`, etc.). Configurable via the `heartbeatIntervalMs` option (set to `0` to disable). Adapters (mocha/playwright/wdio) call `client.stop()` alongside `flush()` at end-of-run so heartbeats don't tick past `run.finished`.

## Consumer wiring

Loaded as an optional peer by `@flakeytesting/cypress-reporter`. Standalone users import the subpath matching their framework directly.

## Side effects of `register()` (Mocha/Cypress)

After a successful `POST /live/start`, the Mocha adapter in `src/mocha.ts` performs these cross-package integration steps:

1. **Environment population** — sets `process.env.FLAKEY_API_URL`, `process.env.FLAKEY_API_KEY`, `process.env.FLAKEY_LIVE_RUN_ID`, and `process.env.CI_RUN_ID` so sibling `setupNodeEvents` plugins (notably `@flakeytesting/cypress-snapshots`'s streaming upload path) and the main reporter's `/runs` upload can read these without re-configuration.
2. **Cross-process run-id bridge (ancestor walk)** — writes the numeric run id to `$TMPDIR/flakey-reporter/live-run-id-<pid>` for **every pid in this process's ancestor chain** (self, parent, grandparent, …, up to 12 levels or pid 1). Ancestor PIDs are resolved via `execSync("ps -o ppid= -p <pid>")`. This is because in Cypress 15+ the Mocha reporter lives in a different process tree branch from setupNodeEvents — a single pid-based file wouldn't match. By writing one file per ancestor, we guarantee the reporter finds a match when it walks its own ancestor chain (the two chains share at least the cypress-CLI pid). Concurrent `cypress run` invocations have distinct cypress-CLI pids, so their files never collide. All written files are `unlinkSync`ed in `after:run` (again, by walking the current ancestor chain).
3. **`/live/start` race guard** — the Cypress 15 plugin lifecycle can fire `before:run` more than once in some configurations. A shared `startPromise` closure ensures only one `/live/start` call happens even when multiple handler invocations race past the `!runId` check. Without this, two separate placeholder runs get created, their live events get split across them, and the upload lands on the wrong one.

If you add a new framework adapter, replicate the ancestor-walk handoff (or the framework's equivalent) so streaming snapshots and per-test live events work for that framework too.
