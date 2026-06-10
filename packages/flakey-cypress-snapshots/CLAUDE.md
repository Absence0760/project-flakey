# @flakeytesting/cypress-snapshots

Cypress plugin that captures DOM snapshots at each command step and bundles them for upload alongside the run. Snapshots stream to the backend mid-run when a live run is active; otherwise they're written to disk and uploaded by the reporter/CLI at end-of-run.

## Commands

- `pnpm build` — `tsc` → `dist/`
- `pnpm dev` — `tsc --watch`

## Plugin options

`flakeySnapshots(on, config, options?)` accepts three options (see `src/plugin.ts`):

| Option | Type | Default | Notes |
|---|---|---|---|
| `outputDir` | `string` | `"cypress/snapshots"` | Where snapshot bundles are written. |
| `enabled` | `boolean` | `true` | Set `false` to disable capture entirely (added in 0.5.0). Exposed to the support file via `Cypress.env("FLAKEY_SNAPSHOTS_ENABLED")`. |
| `maxHtmlBytes` | `number` | `2 * 1024 * 1024` (2 MB) | Per-step HTML size cap. Oversized DOMs (e.g. PDF viewer iframes) are replaced with a placeholder, and a `console.warn` is emitted so users see when it trips. Exposed as `Cypress.env("FLAKEY_SNAPSHOTS_MAX_HTML_BYTES")`. Added in 0.6.1. |
| `maxBundleBytes` | `number` | `64 * 1024 * 1024` (64 MB) | Aggregate cap across all steps in one test. Oldest steps are evicted FIFO when the running total exceeds this — a second line of defence against bundles that stay under the per-step cap but collectively exceed what `cy.task`'s `JSON.stringify` can serialize. Exposed as `Cypress.env("FLAKEY_SNAPSHOTS_MAX_BUNDLE_BYTES")`. Added in 0.6.2. |
| `unlinkAfterStream` | `boolean` | `true` | After a bundle streams successfully to a live run, the local `.json.gz` is deleted to bound disk use over a long suite. Set `false` to **keep** the local file after streaming — required when `outputDir` doubles as a persistent corpus that must survive live runs (e.g. a DOM-dump corpus consumed by a selector-reconcile tool). Only affects the streaming path; the no-live-run path always retains the file for the end-of-run batch. |

Cap accounting: `state.cappedCount` / `state.evictedCount` (in `shared.ts`) are reset by `resetState()` on `test:before:run` and surfaced both via a `console.warn` summary at end-of-test and as `cappedSteps` / `evictedSteps` fields on the `SnapshotBundle`. `cappedCount` is incremented by `capHtml()`; `evictedCount` counts **both** eviction paths — the step-count ring buffer (`MAX_STEPS`, in `appendStep`) and the aggregate-byte cap (`enforceBundleSize`) — so a test that drops steps either way reports a truthful count. The Node-side plugin prints the counts inline with the save line (e.g. `[3 placeholder'd, 7 evicted]`).

The user-facing doc lives at `docs/plugin.md` (next to this file).

## Per-step console + network (Phase 3)

Each `SnapshotStep` carries optional `console[]` (`{ level, text }`) and
`network[]` (`{ method, url, status? }`) — the console output and HTTP requests
captured **during the command that step represents**, rendered per-step in the
dashboard's snapshot viewer. Both are absent when nothing was observed, so the
bundle stays backward-compatible.

How it's captured (all in `shared.ts` + `support.ts`):

- `support.ts` registers `Cypress.on("window:before:load", instrumentWindow)`.
  `instrumentWindow(win)` wraps the app window's `console.{log,info,warn,error}`,
  `fetch`, and `XMLHttpRequest`, routing each call to `recordConsole` /
  `recordNetwork`. It **observes, never swallows** (always calls through).
- Records land in `state.pendingConsole` / `state.pendingNetwork` — capped per
  inter-command window (`MAX_CONSOLE_PER_STEP = 100`, `MAX_NETWORK_PER_STEP = 50`,
  mirroring `@flakeytesting/playwright-snapshots`). `console.warning` is folded
  to `"warn"`; a request that never completed records with no `status`.
- `pushStep` drains the pending buffers into the step it creates (`takePending`),
  so entries attach to the command they occurred during. **Gherkin marker steps
  do NOT drain** — they're group boundaries, not commands, so the console/network
  flows to the real command step that follows. The `afterEach` failure frame
  also drains pending (the error / failing request is usually the most telling).
- `resetState` clears the pending buffers per test.

This is **independent of** `@flakeytesting/cypress-reporter`'s test-level
`failure_context` capture (which also wraps console/fetch/XHR). Both can run in
the same suite: each wrapper records into its own buffer and calls through, so
neither double-counts. `instrumentWindow` is extracted (not inlined in the
support handler) so the interception is unit-testable against a fake window —
see `src/tests/shared.test.ts`.

## Live streaming

When `FLAKEY_API_URL`, `FLAKEY_API_KEY`, and `FLAKEY_LIVE_RUN_ID` are all set in `process.env`, the `flakey:saveSnapshot` task streams the compressed bundle to `POST /live/:runId/snapshot` immediately after writing to disk. On a 2xx response the local file is `unlinkSync`ed. On failure the file is retained so the end-of-run batch uploader (reporter / CLI) can still ship it. These env vars are populated automatically by `@flakeytesting/live-reporter`'s `register()`.

## Test title format

`bundle.testTitle` is the full title path joined with spaces (e.g. `"Content Class Features Tests UI tests Edit displayName"`), derived from `Cypress.currentTest.titlePath`, not the leaf title. This matches the backend `tests.full_title` column for linking.

## Layout

- `src/plugin.ts` — Cypress plugin (runs in Node; registers the `flakey:saveSnapshot` task; handles disk write + streaming upload)
- `src/support.ts` — Cypress support file (runs in the browser; wires `command:end` → `pushStep` and the `afterEach` bundle save)
- `src/shared.ts` — shared browser-side state: ring buffer (max 300 steps), `pushStep`, `serializeDOM`, `getAppDocument`, `isEnabled`. Imported by both `support.ts` and `cucumber.ts`.
- **Gherkin step markers are automatic from `support.ts`.** Its `command:end` handler reads `@badeball`'s active pickle step (`window.testState.pickleStep`) and calls `markGherkinStep` when it changes, pushing a `commandName: "gherkin"` marker so snapshots group under each Given/When/Then. No extra wiring — the `./support` import every consumer already has is enough. `markGherkinStep` (in `shared.ts`) dedupes by pickle-step id and resets in `resetState`.
- `src/cucumber.ts` — **optional**, no longer required for Gherkin grouping. Registers a `BeforeStep` hook (via `@badeball/cypress-cucumber-preprocessor`) that calls the same `markGherkinStep`. Its only advantage over the support-file detector is timing — the marker fires *before* the step's first command rather than at it; the dedup makes importing both safe (no duplicate markers). **If you do import it, it MUST come from a step-definition file (matched by the preprocessor's `stepDefinitions` glob), NOT `cypress/support/e2e.ts`** — `BeforeStep()` needs the preprocessor's per-feature registry, which doesn't exist in the support context, so it throws `"Expected to find a global registry"` (swallowed by Cypress as a vague "uncaught error outside of a test", aborting every spec).
- `plugin.js` / `support.js` / `cucumber.js` — thin JS entries that re-export from `dist/`.
- `plugin.d.ts` / `support.d.ts` / `cucumber.d.ts` — type stubs so consumers on default Node module resolution get types without relying on the `exports` conditional map.
- Build output goes to `dist/`; published files are declared in `package.json` `files`.

## Consumer wiring

```ts
// cypress.config.ts
import { flakeySnapshots } from "@flakeytesting/cypress-snapshots/plugin";

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      flakeySnapshots(on, config);
      return config;
    },
  },
});

// cypress/support/e2e.ts
import "@flakeytesting/cypress-snapshots/support";
// Cucumber projects get Gherkin step grouping automatically from the import
// above. The ./cucumber subpath is now OPTIONAL — import it (from a
// step-definition file, never the support file) only if you want the marker
// emitted by a BeforeStep hook (fires before the step's first command).
```

## Peer deps

- `cypress >=12.0.0` (required). Don't add Cypress as a direct dep.
- `@badeball/cypress-cucumber-preprocessor >=20.0.0` (optional — only needed when the consumer imports the `./cucumber` subpath).
