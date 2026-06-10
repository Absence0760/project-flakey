# Proposal: Snapshot step enrichment — per-step console + network

**Status:** Partially implemented.
- **Phase 0 — render `failure_context`:** ✅ done (commit surfacing the Cypress
  reporter's already-captured console/network/uncaught/retry context in the
  ErrorModal Details tab).
- **Phase 1 — Playwright per-step extraction:** ✅ done (`@flakeytesting/playwright-snapshots`
  now attaches `console[]` / `network[]` to each `SnapshotStep`). **Not yet
  shipped** — a package version bump + publish is the trigger (operator's call).
- **Phase 2 — per-step UI:** ✅ done (step-row error badges in the ErrorModal
  command list + a collapsible console/network strip in the SnapshotViewer,
  scoped to the active step).
- **Phase 3 — Cypress per-step capture:** ✅ done
  (`@flakeytesting/cypress-snapshots` now buffers console + network per step).
  **Not yet shipped** — needs a package version bump + publish.

**Area:** `packages/flakey-playwright-snapshots`, `packages/flakey-cypress-snapshots`,
`frontend/src/lib/components/media/SnapshotViewer.svelte`,
`frontend/src/lib/components/overlays/ErrorModal.svelte`. No backend / DB change
— the snapshot bundle is an opaque gzipped JSON blob in storage, and
`failure_context` is an existing JSONB column (migration 054).

**Effort:** Phases 0–1 small/medium and done. Phase 2 small (frontend). Phase 3
medium and invasive (runs in every customer Cypress test).

---

## Problem

The snapshot-steps list (ErrorModal) shows a flat list of step names
(`updateFeatureFlag`, `request`, …) and a DOM/screencast frame per step. There's
no console output, no network activity, no "what went wrong here" — the steps
look plain. Users debugging a red want the console + network context attached to
the step where it happened, the way a trace viewer shows it.

## What already existed (the discovery)

The Cypress reporter (`@flakeytesting/cypress-reporter/src/support.ts`) **already
captures** browser console, network failures, uncaught errors, and the retry
trail into `tests.failure_context` (JSONB, migration 054). It's typed end-to-end
(`backend/src/types.ts` → `frontend/src/lib/api.ts` → `openapi.yaml`) and
returned by `GET /tests/:id` — but it was **rendered nowhere**. Half the ask was
already being captured and silently dropped.

Two distinct gaps, very different cost:

| | Source | Granularity | Cost |
|---|---|---|---|
| A. `failure_context` unrendered | Cypress reporter (built) | test-level | frontend-only, zero-risk |
| B. Snapshot steps plain | snapshot bundle | per-step | reporter + frontend |

## Phase 0 — render `failure_context` (done)

Frontend-only. The ErrorModal **Details** tab now opens on
`hasMetadata || hasFailureContext`, and renders `browser_console`,
`network_failures`, `uncaught_errors`, and `retry_errors` as sections when
present. Error/warn console lines are colour-coded (`--color-fail` /
`--color-skip`). Seeded a deterministic `failure_context` on the `e2e-cucumber`
demo run; covered by `frontend/tests-e2e/errors/failure-context.spec.ts`.

This already lifts the **Cypress** case (which is what the original screenshot
was — `cy.*` commands + Gherkin grouping) from "plain step names" to
"console + network + uncaught + retry context", at test granularity.

## Phase 1 — Playwright per-step extraction (done)

The Playwright trace `.zip` already carries everything; we parsed neither the
inline console events nor the separate `trace.network` file (the latter was
explicitly *excluded* by the library-trace filter). Now both are extracted and
each event is bucketed to the step that was **active** when it occurred (latest
step whose action had started by the event's monotonic time; pre-first-step
events fall to step 0 — console `time` and HAR `_monotonicTime` share the action
clock).

Contract (backward-compatible — both optional, absent when empty):

```ts
interface SnapshotStep {
  // …existing…
  console?: { level: string; text: string }[];   // "warning" → "warn"
  network?: { method: string; url: string; status?: number }[]; // -1 status omitted
}
```

Per-step caps (`MAX_CONSOLE_PER_STEP = 100`, `MAX_NETWORK_PER_STEP = 50`) bound
bundle growth, mirroring `@flakeytesting/cypress-snapshots`. The collector reads
both the 1.59 `trace.network` name and the legacy `*-network.trace`, per the
package's "trace format is an external contract" convention. Covered by unit
tests in `src/tests/parse-trace.test.ts`.

**Trigger to ship:** bump `@flakeytesting/playwright-snapshots` (and rebuild
`@flakeytesting/playwright-reporter`), then publish per the repo's release flow.

## Phase 2 — per-step UI (done)

Consumes the Phase 1 contract in the frontend:

- **Step-row badges** in the ErrorModal command list (both the gherkin
  command-log branch and the snapshot-steps branch): a count badge that turns
  red when the step carries console **errors** or failed requests, so a problem
  step stands out in the otherwise-flat list — the direct fix for "they look
  plain".
- **Console / Network strip** in `SnapshotViewer.svelte` — a collapsible panel
  under the frame, scoped to the active step, with console lines colour-coded by
  level and failed requests flagged.
- The shared count/failure logic lives in `snapshot-match.ts`
  (`stepDiagnostics` / `isNetworkFailure`, unit-tested) so both consumers agree.
  The frontend `SnapshotStep` interfaces gained the optional
  `console?` / `network?` fields.

The seed attaches per-step console/network to the gherkin demo bundle so the UI
is visible in local dev and exercised by e2e
(`frontend/tests-e2e/errors/snapshot-viewer.spec.ts`).

**Bug fixed in build:** `stepDiagnostics` is null-safe — a row can resolve a
step index before `snapshotSteps` finishes loading, so the helper must tolerate
an undefined step rather than throwing and aborting the whole modal render.

## Phase 3 — Cypress per-step capture (done)

Cypress's `failure_context` is **test-level**. Per-step console/network now lives
in `@flakeytesting/cypress-snapshots` (which owns the step state), independent of
the reporter:

- `support.ts` registers `Cypress.on("window:before:load", instrumentWindow)`.
  `instrumentWindow(win)` (in `shared.ts`) wraps the app window's
  `console.{log,info,warn,error}`, `fetch`, and `XMLHttpRequest`, routing each
  call to `recordConsole` / `recordNetwork`. It observes, never swallows.
- Records buffer into `state.pendingConsole` / `state.pendingNetwork`, capped per
  inter-command window (100 console / 50 network, matching the Playwright
  package). `pushStep` drains them (`takePending`) into the real command step —
  **not** gherkin marker steps — so each entry attaches to the command it
  occurred during. The `afterEach` failure frame also drains pending.

**Why it's self-contained (not shared with the reporter's hooks):** both the
reporter (`failure_context`) and the snapshots package wrap console/fetch/XHR.
Rather than couple them, each keeps its own wrapper and buffer — the wrappers
chain (each calls through), so neither double-counts. This keeps snapshots
usable without the reporter and avoids a cross-package capture dependency.

`instrumentWindow` is extracted (not inlined in the support handler) precisely so
the browser interception is **unit-testable against a fake window in Node** —
`src/tests/shared.test.ts` covers console/fetch wrapping, the never-completed
(rejected fetch) case, caps, drain semantics, and the disabled no-op. The full
Cypress→bundle→backend→frontend round trip for per-step data isn't run in CI (it
needs a live Cypress browser); the bundle→UI half is e2e-covered by Phase 2 and
the producer mechanics by these unit tests.

The cost — it runs inside every customer Cypress test — is bounded by the
per-step caps and gated by `FLAKEY_SNAPSHOTS_ENABLED` (`instrumentWindow` no-ops
when snapshots are off, so suites that don't opt in pay nothing).

## Why this order

Phase 0 ships the highest-value, lowest-risk slice (data already captured, just
unrendered) and directly helps the Cypress case from the original report.
Phase 1 is "free" data already in the Playwright trace, behind a moderate
parse-side change. Phase 2 is the per-step UX. Phase 3 — the only invasive piece
(it runs in every Cypress test) — was kept last and bounded by per-step caps +
the enable flag.

## Open question

Phase 0 revealed that `failure_context` is Cypress-only. The Playwright reporter
could also populate test-level `failure_context` (it has the trace), so Gap A
isn't permanently lopsided. Small add while in the trace parser — decide when
Phase 2/3 are scheduled.
