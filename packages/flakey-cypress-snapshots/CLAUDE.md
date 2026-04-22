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

Cap accounting: `state.cappedCount` / `state.evictedCount` (in `shared.ts`) are reset by `resetState()` on `test:before:run`, incremented by `capHtml()` and `enforceBundleSize()`, and surfaced both via a `console.warn` summary at end-of-test and as `cappedSteps` / `evictedSteps` fields on the `SnapshotBundle`. The Node-side plugin prints the counts inline with the save line (e.g. `[3 placeholder'd, 7 evicted]`).

The user-facing doc lives at `docs/plugin.md` (next to this file).

## Live streaming

When `FLAKEY_API_URL`, `FLAKEY_API_KEY`, and `FLAKEY_LIVE_RUN_ID` are all set in `process.env`, the `flakey:saveSnapshot` task streams the compressed bundle to `POST /live/:runId/snapshot` immediately after writing to disk. On a 2xx response the local file is `unlinkSync`ed. On failure the file is retained so the end-of-run batch uploader (reporter / CLI) can still ship it. These env vars are populated automatically by `@flakeytesting/live-reporter`'s `register()`.

## Test title format

`bundle.testTitle` is the full title path joined with spaces (e.g. `"Content Class Features Tests UI tests Edit displayName"`), derived from `Cypress.currentTest.titlePath`, not the leaf title. This matches the backend `tests.full_title` column for linking.

## Layout

- `src/plugin.ts` — Cypress plugin (runs in Node; registers the `flakey:saveSnapshot` task; handles disk write + streaming upload)
- `src/support.ts` — Cypress support file (runs in the browser; wires `command:end` → `pushStep` and the `afterEach` bundle save)
- `src/shared.ts` — shared browser-side state: ring buffer (max 300 steps), `pushStep`, `serializeDOM`, `getAppDocument`, `isEnabled`. Imported by both `support.ts` and `cucumber.ts`.
- `src/cucumber.ts` — optional Cucumber/Gherkin integration. Registers a `BeforeStep` hook via `@badeball/cypress-cucumber-preprocessor` that pushes `commandName: "gherkin"` markers into the bundle. Only pulled in when the consumer imports the `./cucumber` subpath.
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

// Cucumber projects only — adds Gherkin step markers to the bundle:
// import "@flakeytesting/cypress-snapshots/cucumber";
```

## Peer deps

- `cypress >=12.0.0` (required). Don't add Cypress as a direct dep.
- `@badeball/cypress-cucumber-preprocessor >=20.0.0` (optional — only needed when the consumer imports the `./cucumber` subpath).
