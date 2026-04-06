# Cypress DOM Snapshot Plugin

A Cypress plugin that captures DOM snapshots at each command step during test execution, enabling interactive DOM replay in the Flakey UI.

## Overview

When debugging test failures, seeing what the DOM looked like at each step is invaluable. This plugin hooks into Cypress's command lifecycle to capture incremental DOM mutations, producing a lightweight snapshot bundle that can be replayed step-by-step in the browser.

Instead of capturing full HTML at every step (which would be 2-8MB per test), the plugin captures a **base snapshot** on page load and **incremental diffs** at each command boundary using MutationObserver. A typical 40-step test produces 20-100KB uncompressed (5-30KB gzipped).

## Architecture

```
Cypress Test Run
    │
    ├── cy.visit() ──────────────► Full DOM serialization (base snapshot)
    ├── cy.get()   ──────────────► MutationObserver diff (step 1)
    ├── cy.click() ──────────────► MutationObserver diff (step 2)
    ├── cy.type()  ──────────────► MutationObserver diff (step 3)
    │   ...
    └── test:after:run ──────────► Bundle & gzip → cypress/snapshots/<spec>/<test>.json.gz
                                        │
                                        ▼
                                  CLI Reporter uploads
                                        │
                                        ▼
                                  Backend stores at uploads/runs/{id}/snapshots/
                                        │
                                        ▼
                                  Frontend replays in sandboxed <iframe>
```

## Data Format

### SnapshotBundle

Each test produces a single gzipped JSON file containing:

```typescript
interface SnapshotBundle {
  version: 1;
  baseSnapshot: {
    html: string;             // Full serialized DOM via rrweb-snapshot
    stylesheets: string[];    // Inlined CSS text from document.styleSheets
    dimensions: {
      width: number;          // Viewport width at capture time
      height: number;         // Viewport height at capture time
    };
  };
  steps: SnapshotStep[];
}

interface SnapshotStep {
  index: number;              // Matches command_log array position
  commandName: string;        // e.g. "get", "click", "type"
  commandMessage: string;     // e.g. "[data-testid='submit']"
  timestamp: number;          // Milliseconds from test start
  mutations: object[];        // rrweb incremental mutation records
  scrollPosition?: {
    x: number;
    y: number;
  };
}
```

### Size Expectations

| Metric | Typical Value |
|---|---|
| Base snapshot | 50-200KB |
| Per-step diff | 0.5-5KB |
| 40-step test (uncompressed) | 50-200KB |
| 40-step test (gzipped) | 5-30KB |
| 200-test suite | 1-6MB total |

## Cypress Plugin

### Installation

```bash
npm install @flakey/cypress-snapshots
```

### Setup

**cypress.config.ts:**

```typescript
import { flakeySnapshots } from "@flakey/cypress-snapshots/plugin";

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      flakeySnapshots(on, config, {
        // Capture mode: "all" | "failed" | "none"
        // Default: "failed"
        mode: "failed",

        // Max steps per test before sampling
        // Default: 200
        maxSteps: 200,

        // Max uncompressed bundle size in bytes
        // Default: 2MB
        maxBundleSize: 2 * 1024 * 1024,

        // Output directory for snapshot files
        // Default: "cypress/snapshots"
        outputDir: "cypress/snapshots",
      });
    },
  },
});
```

**cypress/support/e2e.ts:**

```typescript
import "@flakey/cypress-snapshots/support";
```

### How Capture Works

1. **`test:before:run`** — Initializes a MutationObserver on the app iframe's document. Resets snapshot state for the new test.

2. **`cy.visit` completes** — Takes a full base snapshot:
   - Serializes the entire DOM tree using `rrweb-snapshot`'s `serializeNodeWithId()`
   - Inlines all stylesheets by reading `document.styleSheets` and serializing each rule
   - Records viewport dimensions

3. **`command:end`** (each step) — Captures incremental changes:
   - Flushes the MutationObserver's pending records
   - Serializes mutations using rrweb's mutation serializer
   - Skips steps with zero mutations (e.g. `cy.log`, `cy.wrap`)
   - Records scroll position

4. **`test:after:run`** — Finalizes the bundle:
   - Assembles `SnapshotBundle` JSON
   - Gzip-compresses via Node's `zlib.gzipSync()`
   - Writes to `cypress/snapshots/<specName>/<testTitle>.json.gz`

### Asset Handling

| Asset Type | Strategy |
|---|---|
| Stylesheets | Inlined as `<style>` blocks at capture time |
| Images | Stored as absolute URLs; displayed as-is during replay (placeholder if unreachable) |
| Fonts | `@font-face` rules captured from computed stylesheets; fallback fonts used if unavailable |
| Scripts | Stripped during serialization (not needed for visual replay) |

### Performance Impact

- **MutationObserver**: Passive, near-zero runtime overhead
- **Per-step serialization**: 1-5ms (Cypress commands typically take 50-500ms)
- **Total overhead per test**: ~50-200ms for 40 steps (<5% of typical test duration)
- **Memory**: ~200KB held in memory per test, cleared between tests

### Snapshot Modes

| Mode | Behavior | Use Case |
|---|---|---|
| `"failed"` (default) | Only persists snapshots for tests that fail | Conservative storage, covers the primary debugging use case |
| `"all"` | Persists snapshots for all tests | Debugging flaky tests that sometimes pass with incorrect DOM state |
| `"none"` | Disables capture entirely | CI runs where storage or speed is critical |

In `"failed"` mode, snapshots are still captured in memory during execution (the plugin doesn't know if a test will fail until it finishes), but the gzip/write step is skipped for passing tests.

## Backend Changes

### Database Migration

```sql
-- 003_dom_snapshots.sql
ALTER TABLE tests ADD COLUMN IF NOT EXISTS snapshot_path TEXT;
```

Single column storing the relative path to the snapshot file (e.g. `runs/42/snapshots/test-123.json.gz`). Snapshots are stored as files (not inline JSONB) to keep the database lean and match the existing pattern used for screenshots and videos.

### Upload Handler

The existing upload endpoint at `POST /runs/:id/upload` needs to accept an additional multipart field:

```
snapshots[]: .json.gz files
```

Files are stored at `uploads/runs/{runId}/snapshots/` and matched to tests using the same filename normalization used for screenshots.

### Serving Snapshots

No new endpoint needed. The existing `express.static("uploads")` middleware serves snapshot files directly:

```
GET /uploads/runs/42/snapshots/test-123.json.gz
```

The browser handles decompression via the `DecompressionStream` API.

## CLI Reporter Changes

Add `--snapshots-dir` option (default: `cypress/snapshots`):

```bash
flakey upload \
  --api http://localhost:3000 \
  --results cypress/results \
  --screenshots cypress/screenshots \
  --snapshots cypress/snapshots
```

The reporter finds `.json.gz` files in the snapshots directory and appends them to the multipart upload alongside screenshots and videos.

## Frontend Changes

### New Component: `SnapshotViewer.svelte`

Renders a snapshot bundle in a sandboxed `<iframe>`:

1. **Fetch**: Loads the `.json.gz` file from `UPLOADS_URL + snapshot_path`
2. **Decompress**: Uses `DecompressionStream` to gunzip in the browser
3. **Replay**: Loads base snapshot HTML into an iframe via `srcdoc`, then applies mutation diffs incrementally up to the selected step
4. **Highlight**: Overlays a highlight box on the DOM element targeted by the current command (if the command has a selector)

The iframe approach provides:
- Complete style isolation (snapshot styles don't leak into the Flakey UI)
- Security sandboxing (no script execution)
- Accurate viewport rendering at original dimensions

### ErrorModal Integration

When a test has `snapshot_path`:

- A **"Snapshot"** tab appears in the left pane (alongside Screenshots and Video)
- Command log entries in the right pane become **clickable**
- Clicking a command step updates the snapshot viewer to show the DOM at that point
- Arrow keys (up/down) step through commands when the command list is focused
- The active command is highlighted with a background color

### Replay Algorithm

```
1. Parse base snapshot into HTML string
2. Set iframe.srcdoc = base HTML
3. For each step from 0 to selectedIndex:
     Apply rrweb mutation records to iframe.contentDocument
4. Cache computed states for adjacent steps (N-1, N+1)
     to enable smooth scrubbing
```

Applying 40 incremental mutation steps is sub-millisecond. The bottleneck is iframe re-rendering (~50-100ms per step change). Pre-computing adjacent steps eliminates perceived latency.

## Implementation Phases

### Phase 1: Backend

- [ ] Add `snapshot_path` column migration
- [ ] Update upload handler to accept and store snapshot files
- [ ] Verify static file serving works for `.json.gz`

### Phase 2: Cypress Plugin

- [ ] Create package structure with `support.ts` and `plugin.ts`
- [ ] Implement MutationObserver-based capture at command boundaries
- [ ] Implement base snapshot serialization on `cy.visit`
- [ ] Write gzipped bundle to disk on `test:after:run`
- [ ] Add `mode` configuration (all/failed/none)
- [ ] Test with a sample Cypress project

### Phase 3: CLI Reporter

- [ ] Add `--snapshots-dir` flag
- [ ] Find and include `.json.gz` files in multipart upload
- [ ] Match snapshot files to tests by filename

### Phase 4: Frontend Viewer

- [ ] Create `SnapshotViewer.svelte` component
- [ ] Add "Snapshot" tab to ErrorModal left pane
- [ ] Make command log entries clickable
- [ ] Implement DOM replay with incremental mutation application
- [ ] Add element highlighting for the current command's target
- [ ] Add keyboard navigation (up/down arrows)

### Phase 5: Polish

- [ ] Add step scrubber/timeline control below the snapshot viewer
- [ ] Pre-render adjacent steps for smooth navigation
- [ ] Add snapshot retention policy (configurable max age)
- [ ] Add storage metrics to the Settings page
- [ ] Handle edge cases: very large DOMs, shadow DOM, cross-origin iframes

## Comparison With Alternatives

| Approach | Fidelity | Size/Test | Speed Overhead | Complexity |
|---|---|---|---|---|
| **Incremental diffs (this plugin)** | High | 5-30KB | ~50-200ms | Medium |
| Screenshot per step | Perfect | 4-20MB | 8-20s | Low |
| Full HTML per step | High | 200-800KB | ~200ms | Low |
| rrweb continuous recording | Highest | 100KB-1MB | Minimal | High |

The incremental diff approach gives 95% of the value of continuous recording at 10% of the storage cost, and avoids the severe performance penalty of per-step screenshots.

## Dependencies

- **[rrweb-snapshot](https://github.com/rrweb-io/rrweb/tree/master/packages/rrweb-snapshot)** — DOM serialization and node ID mapping
- **[rrweb](https://github.com/rrweb-io/rrweb)** — Incremental mutation serialization (used selectively, not the full recorder)
- **Node `zlib`** — Gzip compression (built-in, no external dependency)
- **Browser `DecompressionStream`** — Gzip decompression on the frontend (supported in all modern browsers)
