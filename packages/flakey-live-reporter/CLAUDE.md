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

## Consumer wiring

Loaded as an optional peer by `@flakeytesting/cypress-reporter`. Standalone users import the subpath matching their framework directly.

## Side effects of `register()` (Mocha/Cypress)

After a successful `POST /live/start`, the Mocha adapter in `src/mocha.ts` performs these cross-package integration steps:

1. **Environment population** — sets `process.env.FLAKEY_API_URL`, `process.env.FLAKEY_API_KEY`, `process.env.FLAKEY_LIVE_RUN_ID`, and `process.env.CI_RUN_ID` so sibling `setupNodeEvents` plugins (notably `@flakeytesting/cypress-snapshots`'s streaming upload path) and the main reporter's `/runs` upload can read these without re-configuration.
2. **Cross-process run-id bridge (ancestor walk)** — writes the numeric run id to `$TMPDIR/flakey-reporter/live-run-id-<pid>` for **every pid in this process's ancestor chain** (self, parent, grandparent, …, up to 12 levels or pid 1). Ancestor PIDs are resolved via `execSync("ps -o ppid= -p <pid>")`. This is because in Cypress 15+ the Mocha reporter lives in a different process tree branch from setupNodeEvents — a single pid-based file wouldn't match. By writing one file per ancestor, we guarantee the reporter finds a match when it walks its own ancestor chain (the two chains share at least the cypress-CLI pid). Concurrent `cypress run` invocations have distinct cypress-CLI pids, so their files never collide. All written files are `unlinkSync`ed in `after:run` (again, by walking the current ancestor chain).
3. **`/live/start` race guard** — the Cypress 15 plugin lifecycle can fire `before:run` more than once in some configurations. A shared `startPromise` closure ensures only one `/live/start` call happens even when multiple handler invocations race past the `!runId` check. Without this, two separate placeholder runs get created, their live events get split across them, and the upload lands on the wrong one.

If you add a new framework adapter, replicate the ancestor-walk handoff (or the framework's equivalent) so streaming snapshots and per-test live events work for that framework too.
