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

The Mocha reporter runs in a separate Node process from `setupNodeEvents` and does not inherit env mutations set during plugin registration. `readLiveRunId()` in `src/reporter.ts` therefore checks `process.env.FLAKEY_LIVE_RUN_ID` first, then falls back to reading `$TMPDIR/flakey-reporter/live-run-id` (written by `@flakeytesting/live-reporter`'s `register()`). Both paths must resolve to the same numeric id for per-test live events (`test.started` / `test.passed` / `test.failed` / `test.skipped`) to stream correctly. If you see tests running but no per-test events in the dashboard, check that both paths agree.
