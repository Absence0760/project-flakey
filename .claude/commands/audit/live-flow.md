---
description: Verify live-route invariants — uniqueness fences, stat-recompute, screenshot/snapshot preservation across upload merge, heartbeat behavior
---

Audit the live-event path end-to-end: from the reporter's `LiveClient` through `POST /live/:runId/events` and the screenshot/snapshot streaming endpoints to the end-of-run merge in `/runs` and `/runs/upload`.

## Goal

The live path has a lot of moving parts and several invariants that have been broken before:

- Two concurrent `test.started` events for the same `(spec, full_title)` produce two rows (fixed in migration 030 with a partial unique index).
- A Cypress `spec.finished` event with `stats.skipped: 0` (because Cypress reports `it.skip()` as `pending`, not `skipped`) used to overwrite the live-streamed skipped count to 0 (issue #25 fix).
- The end-of-run upload's "delete and reinsert tests" used to drop streamed `screenshot_paths` because only `snapshot_path` was preserved (issue #23 fix); the same bug existed once on `/runs` and once on `/runs/upload`.
- A long quiet scenario used to trip the 10-minute stale-run timer and trigger a false abort while tests were still running (issue #22 fix — heartbeat).

Each of these is one regression away from coming back. Sweep them.

## What to check

1. **Test-row uniqueness.** Migration `030_tests_pending_unique.sql` adds:
   - `uniq_specs_run_file` (unique on `specs(run_id, file_path)`) — prevents duplicate spec rows from racing `findOrCreateSpec` calls.
   - `idx_tests_pending_unique` (partial unique on `tests(spec_id, full_title) WHERE status = 'pending'`) — prevents duplicate pending rows from concurrent `test.started` events.

   Confirm both indexes are referenced in the live route's `INSERT … ON CONFLICT` clauses (`backend/src/routes/live.ts`'s `findOrCreateSpec` and `upsertPendingTest`). A new endpoint that bypasses the constraint by selecting-then-inserting without `ON CONFLICT` re-opens the race.

2. **`spec.finished` recompute.** `updateLiveSpecStats` in `backend/src/routes/live.ts` now defers to `recomputeSpecAndRunStats` when test rows already exist — only falling back to writing the reporter's `event.stats` payload directly when the spec has zero per-test rows (the Cucumber-only-spec-level case). Confirm:
   - The "do we have test rows for this spec?" check still gates the recompute path
   - `recomputeSpecAndRunStats` counts `status IN ('skipped', 'pending')` for the skipped column (regression risk)
   - No new endpoint writes to `specs.skipped` directly without going through the same path

3. **Screenshot / snapshot preservation across upload merge.** Both `backend/src/routes/uploads.ts` and `backend/src/routes/runs.ts` do `DELETE FROM tests WHERE spec_id = $1` and re-insert from the upload payload. Before that DELETE, both must:
   - Snapshot existing `screenshot_paths` (any rows where the array is non-empty) into a `Map<full_title, string[]>`
   - Snapshot existing `snapshot_path` (rows where it's non-NULL) into a `Map<full_title, string>`
   - On INSERT, union the streamed screenshots with the upload payload's `test.screenshot_paths`, and copy the streamed snapshot_path through

   Confirm both routes have the same shape. They drifted once (uploads.ts had screenshot preservation, runs.ts didn't — caught by tests in commit `bbf04e0`).

4. **Heartbeat / stale-run.** `LiveClient` (in `packages/flakey-live-reporter/src/index.ts`) ticks an `unref`'d 30s interval that calls `flush({ allowEmpty: true })` so the backend's `/events` route bumps `lastEventAt` via `LiveEventBus.touch()` even with no real events. Confirm:
   - The interval is `unref`'d (so it doesn't keep Node alive)
   - Each adapter (`mocha.ts`, `playwright.ts`, `webdriverio.ts`) calls `client.stop()` alongside `flush()` at end-of-run, so the heartbeat doesn't tick past `run.finished`
   - The backend's `events` POST handler calls `liveEvents.touch(runId)` regardless of payload size
   - `FLAKEY_LIVE_TIMEOUT_MS` env var still gates the threshold (default 10 min, tests use 1500ms)

5. **`run.aborted` is sticky.** Once a run is in the `live_events` table with a `run.aborted` event, `GET /runs` and `GET /runs/:id` return `aborted: true`. Confirm the SELECT in `runs.ts` still has the `EXISTS (SELECT 1 FROM live_events …)` clause and that `getStaleRuns` removes the run from `activeRuns` after the abort emits (so the same run isn't repeatedly re-aborted on every check tick).

6. **Reporter env var resolution chain.** `mocha.ts`'s `register()` resolves `environment` from `config.environment ?? FLAKEY_ENV ?? TEST_ENV ?? ""` and forwards it to `/live/start`. `plugin.ts` (cypress reporter) resolves it lazily from `opts.environment ?? FLAKEY_ENV ?? TEST_ENV ?? config.env.environment ?? config.env.name`. Both should resolve in the same order; the cypress reporter has the additional `config.env.*` paths because Cypress merges `--env` into `config.env` after the plugin registers. Drift between the two would make `/live/start` and the upload payload disagree about which env the run targeted.

7. **Test coverage of the invariants.** `backend/src/tests/phase_9_10.smoke.test.ts` has a test for each of the live-flow invariants above (`issue #25`, `issue #22`, `issue #23` named tests). If you find a new live-route invariant that has no test, flag it.

## Report

- **Critical** — uniqueness fence missing on a new live insert; `spec.finished` zeroes a counter that has live test rows; merge upload silently drops streamed artifacts.
- **High** — heartbeat interval not `unref`'d (process can't exit); `client.stop()` missing from a new adapter; new live endpoint without an ownership check (overlaps with `audit/auth`).
- **Medium** — env-var resolution differs between two reporter packages; `run.aborted` derivation slow because the EXISTS join doesn't have an index.
- **Low** — invariant present in code but not asserted in `phase_9_10.smoke.test.ts`.

For each: file:line + the invariant + the recently-fixed PR/commit if you can identify it.

## Useful starting points

- `backend/src/routes/live.ts` — `findOrCreateSpec`, `upsertPendingTest`, `insertLiveTestResult`, `updateLiveSpecStats`, `recomputeSpecAndRunStats`, the streaming `/snapshot` and `/screenshot` endpoints
- `backend/src/routes/uploads.ts` — multipart merge path
- `backend/src/routes/runs.ts` — JSON merge path (same shape, easy to drift from uploads.ts)
- `backend/src/run-merge.ts` — `findOrCreateRun`, `recalculateRunStats`
- `backend/src/live-events.ts` — `LiveEventBus`, including `touch()` and `getStaleRuns()`
- `packages/flakey-live-reporter/src/index.ts` — `LiveClient` heartbeat
- `packages/flakey-live-reporter/src/{mocha,playwright,webdriverio}.ts` — adapters that own `client.stop()`
- `backend/src/tests/phase_9_10.smoke.test.ts` — the live-flow regression suite
- `backend/migrations/030_tests_pending_unique.sql` — the uniqueness fences

## Delegate to

Use the `flakey-auditor` agent: `"Audit live-route invariants — uniqueness fences, recompute paths, screenshot/snapshot preservation, heartbeat / stale-run timing."` Read-only.
