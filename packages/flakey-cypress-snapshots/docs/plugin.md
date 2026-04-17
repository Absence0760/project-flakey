# Cypress DOM Snapshot Plugin

A Cypress plugin that captures DOM snapshots at each command step during test execution, enabling step-by-step DOM replay in the Better Testing UI.

## Overview

When debugging test failures, seeing what the DOM looked like at each step is invaluable. The plugin hooks Cypress's `command:end` event and, for each non-skipped command, serializes the entire AUT document and stores it as a step in a ring buffer. On `afterEach`, the accumulated steps are gzipped into a per-test bundle and either streamed to the backend immediately (when a live run is active) or written to disk for the end-of-run batch uploader.

The implementation is deliberately straightforward: full HTML per step, no rrweb, no mutation diffing. Bundles are larger than a diff-based approach, but the code is small, the replay UI is trivial, and gzip compresses repeated DOM structure well in practice. The ring buffer (default 300 steps) keeps bundle size bounded for long-running scenarios.

## Architecture

```
Cypress Test Run
    │
    ├── test:before:run ─────────► Reset step state + timer
    │
    ├── command:end (each command) ──► serializeDOM() → push to ring buffer (max 300)
    │
    ├── BeforeStep (Cucumber, opt-in) ──► push "gherkin" marker with Given/When/Then text
    │
    └── afterEach
            │
            ├── Append failure step if test failed
            ├── Build SnapshotBundle (version: 1, steps[], testTitle, specFile, …)
            ├── cy.task("flakey:saveSnapshot") → Node-side plugin
            │     │
            │     ├── gzip → outputDir/<spec>--<title>.json.gz
            │     └── FLAKEY_LIVE_RUN_ID set?
            │           │ yes                           │ no
            │           ▼                               ▼
            │   POST /live/:runId/snapshot          (keep on disk)
            │   (multipart; 2xx ⇒ unlinkSync)            │
            │                                            ▼
            └─────────────────────────────► CLI / reporter batch upload
                                            at end of run (fallback)

                                              Frontend loads bundle,
                                              renders current step HTML
                                              in sandboxed <iframe>
```

## Data format

Each test produces one gzipped JSON file. Schema (from `src/plugin.ts` and `src/shared.ts`):

```typescript
interface SnapshotBundle {
  version: 1;
  testTitle: string;        // Full title path joined with " " (e.g. "Login flow should redirect after logout")
  specFile: string;         // Cypress spec relative path
  viewportWidth: number;
  viewportHeight: number;
  steps: SnapshotStep[];
}

interface SnapshotStep {
  index: number;            // Monotonic counter from test start
  commandName: string;      // e.g. "get", "click", "gherkin", "failure"
  commandMessage: string;   // e.g. "[data-testid='submit']", or "Given I am on the login page"
  timestamp: number;        // ms since test start
  html: string;             // Full serialized DOM at this step (scripts stripped, CSS inlined)
  scrollX: number;
  scrollY: number;
}
```

There is **no** `baseSnapshot`, `mutations[]`, or `rrweb` involvement. Every step holds complete HTML.

## How capture works

1. **`test:before:run`** — resets the ring buffer, the command counter, and the test start timestamp.
2. **`command:end`** (browser-side, via `Cypress.on`) — for each command whose name is not in `SKIP_COMMANDS`, calls `serializeDOM()`:
   - Clones the AUT iframe's `documentElement`.
   - Removes all `<script>` elements.
   - Inlines computed CSS from every stylesheet into a single `<style data-flakey-inlined="true">` block inside `<head>`, and strips `<link rel="stylesheet">` references (so the replay iframe renders correctly without network access).
   - Stores the resulting HTML string as a new `SnapshotStep`.
   - If the buffer exceeds `MAX_STEPS` (300), shifts the oldest entry. The ring-buffer behavior preserves the most recent commands — useful when a heavy `before` hook would otherwise exhaust capacity before the test body runs.
3. **`BeforeStep` (Cucumber only)** — if the consumer imports `@flakeytesting/cypress-snapshots/cucumber`, a `BeforeStep` hook is registered via `@badeball/cypress-cucumber-preprocessor`. Before each Gherkin step runs, a synthetic step with `commandName: "gherkin"` and `commandMessage: "Given/When/Then <text>"` is pushed. The viewer renders these with distinct styling so Cypress commands group visually under their scenario step.
4. **`afterEach`** — if the test failed, appends one final step `{ commandName: "failure", commandMessage: "Test failed — final DOM state", … }`. Then builds the `SnapshotBundle` and dispatches `cy.task("flakey:saveSnapshot", bundle)` to the Node plugin.

**SKIP_COMMANDS** (`src/support.ts`): `wrap`, `then`, `should`, `and`, `its`, `invoke`, `as`, `within`, `wait`, `task`, `exec`, `readFile`, `writeFile`, `fixture`, `screenshot`, `debug`, `pause`. These are control-flow or side-effect-free commands that don't change the DOM in ways worth capturing. `cy.log` is **not** skipped — its messages are useful context, and Cucumber-preprocessor often emits step markers via `cy.log`.

## Node-side plugin (`flakey:saveSnapshot` task)

Registered by `flakeySnapshots(on, config, options?)` in `src/plugin.ts`. Received bundles are gzipped via `zlib.gzipSync` and written to `{outputDir}/<sanitized-spec>--<sanitized-title>.json.gz`.

If all three env vars are set (usually by `@flakeytesting/live-reporter`'s `register()`), the plugin additionally streams the file to the backend:

```
FLAKEY_API_URL          (e.g. http://localhost:3000)
FLAKEY_API_KEY          (fk_… token)
FLAKEY_LIVE_RUN_ID      (numeric run id, set after /live/start)
```

Upload target: `POST /live/:runId/snapshot` as `multipart/form-data` with fields `snapshot` (the `.gz` file), `spec`, and `testTitle`. On a 2xx response the local file is `unlinkSync`ed. On any failure, the file is retained so the reporter/CLI's end-of-run batch upload still picks it up. The backend matches bundles to `tests` rows by `full_title` when linking `snapshot_path`.

## Options

```ts
flakeySnapshots(on, config, {
  outputDir: "cypress/snapshots",   // default
  enabled: true,                     // default; set false to disable capture entirely
});
```

`enabled` is exposed to the browser context as `Cypress.env("FLAKEY_SNAPSHOTS_ENABLED")` so `support.ts` can short-circuit without doing any work.

## Replay (frontend)

The backend serves bundles at `/uploads/runs/{runId}/snapshots/<name>.json.gz`. The `SnapshotViewer.svelte` component:

1. Fetches the bundle and decompresses it via the browser's `DecompressionStream("gzip")`.
2. Renders each step's `html` string into a sandboxed `<iframe>` via `srcdoc`, and scrolls to the step's `scrollX`/`scrollY`.
3. Exposes a `selectedStep` prop (`$bindable` in Svelte 5) plus internal prev/next navigation so `ErrorModal` can drive the viewer from its Commands panel.

`ErrorModal` falls back to rendering the bundle's own steps list when `test.command_log` is empty, grouping `"gherkin"` markers into collapsible scenario sections.

## Peer deps

- `cypress >=12.0.0` (required)
- `@badeball/cypress-cucumber-preprocessor >=20.0.0` (optional — only needed when the consumer imports the `./cucumber` subpath)
