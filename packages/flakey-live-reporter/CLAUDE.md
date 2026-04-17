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

After a successful `POST /live/start`, the Mocha adapter in `src/mocha.ts` performs two cross-package integration steps:

1. **Environment population** — sets `process.env.FLAKEY_API_URL` and `process.env.FLAKEY_API_KEY` from the constructor args, so sibling `setupNodeEvents` plugins (notably `@flakeytesting/cypress-snapshots`'s streaming upload path) can read credentials without re-configuration.
2. **Cross-process run-id bridge** — writes the numeric run id to `$TMPDIR/flakey-reporter/live-run-id-<pid>`, where `<pid>` is the main Cypress process's PID (== this module's `process.pid`). Cypress spawns the Mocha reporter in a separate Node process that does not inherit env mutations from `setupNodeEvents`; the reporter (`@flakeytesting/cypress-reporter`) reads the file via `readLiveRunId()`, using `process.ppid` to resolve the matching path. The PID scoping lets two concurrent `cypress run` terminals on the same machine coexist without stomping each other's run ids. The file is `unlinkSync`ed in `after:run`.

If you add a new framework adapter, replicate these two side effects (or the framework's equivalent) so streaming snapshots and per-test live events work for that framework too.
