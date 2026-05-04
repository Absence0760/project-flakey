---
description: Audit README, docs/*, and per-package CLAUDE.md against what the code actually does
---

Survey the project's docs for stale references after a change to endpoints, schema, env vars, or reporter behavior.

## Goal

Endpoint lists, env-var tables, schema descriptions, and "how the live path works" walkthroughs accumulate drift fast. A reader (or a future agent that reads CLAUDE.md to bootstrap) acts on the doc; the doc lies; bug. Sweep the docs against current reality and report each delta.

## What to check

1. **Endpoint inventory.** `docs/architecture.md` § "Authenticated endpoints" lists every API route. Cross-reference each against `backend/src/routes/*.ts`:
   - Routes registered in `backend/src/index.ts` but not listed in the doc (drift forward)
   - Routes listed in the doc but no longer registered (drift backward)
   - Method (GET / POST / PATCH) drift
   - Param-shape drift (e.g. doc says `?ci_run_id=X` but code expects `?ciRunId=X`)

2. **Schema description.** `docs/architecture.md` § "Database schema" describes the columns on each table. Cross-reference against the actual columns from `backend/migrations/*.sql`. Recent additions to verify:
   - `runs.environment` (migration 033) — should be in the schema doc
   - `tests.snapshot_path`, `tests.command_log`, `tests.metadata` — confirm the column list is current

3. **Live event flow diagram.** `docs/architecture.md` has an ASCII flow showing the live reporter, `/live/start`, the events stream, the snapshot/screenshot streaming endpoints, the heartbeat, and the abort path. Cross-reference each box against `backend/src/routes/live.ts`. Recent additions to verify:
   - `POST /live/:runId/screenshot`
   - The 30s heartbeat (empty-body POST `/live/:runId/events`)
   - `LiveEventBus.touch()` reset path

4. **Per-package CLAUDE.md.** Each `packages/*/CLAUDE.md` describes what the package does, env vars it reads, and consumer wiring. For each, cross-reference:
   - **`flakey-cypress-reporter/CLAUDE.md`** — claims `after:screenshot` streaming, `streamedScreenshotPaths` Set, `/runs` and `/runs/upload` preservation, environment resolution chain. All should match `src/plugin.ts`.
   - **`flakey-cypress-snapshots/CLAUDE.md`** — claims the streaming `flakey:saveSnapshot` task and the local-file unlink. All should match `src/plugin.ts`.
   - **`flakey-live-reporter/CLAUDE.md`** — env-var table; the heartbeat section; `client.stop()` teardown. All should match `src/index.ts`, `src/mocha.ts`, `src/playwright.ts`, `src/webdriverio.ts`.
   - Other packages — same drill.

5. **`README.md` (top-level).** The "Quick start" / "Usage" sections instruct users on:
   - Cypress consumer config (the `setupFlakey` form)
   - How screenshots / snapshots / videos upload (per-test streaming vs end-of-run batch)
   - How to label environments (`FLAKEY_ENV` / `--env name=`)

   Each of those was updated in commit `e1cb69f`; if a follow-up PR has changed the behavior, the README needs to follow.

6. **`backend/CLAUDE.md` and `frontend/CLAUDE.md`.** These are the per-app conventions. Watch for:
   - Backend: claims about commands (`npm run dev`, `npm run seed`, etc.) — confirm they match `backend/package.json` scripts
   - Frontend: claims about ports (7777 dev, 8888 preview), localStorage keys (`bt_*`), runes-only Svelte 5 — confirm code conformance
   - Both: mentions of specific migrations / commit hashes (e.g. "the rebrand landed in commit 95efd7d") — confirm those are still in `git log`

7. **`docs/run-locally.md`.** Setup instructions for local dev. Confirm:
   - Env-var list matches what `backend/src/index.ts` and `frontend/vite.config.ts` actually read
   - `pnpm dev` / `pnpm db:up` / `pnpm db:down` / `pnpm db:reset` match root `package.json`
   - Migration apply step reflects current `backend/migrate.sh`

8. **Roadmap.** `docs/roadmap.md` has `[x]` boxes for shipped features. Spot-check the most recently checked items against the codebase — a shipped item that's actually been removed is rare but worth catching.

## Report

- **High** — a doc claims an API endpoint or env var that doesn't exist (a user following the doc will hit a 404 or be confused why nothing happens).
- **Medium** — schema description omits a recently-added column; per-package CLAUDE.md missing a streaming endpoint or a peer-dep that's now load-bearing; README mentions an outdated default port or env var.
- **Low** — minor wording drift; commit hash in a doc no longer in `git log` (or now superseded by a follow-up commit); roadmap unchecked for a feature that's been shipped.

For each: doc file + line + the actual reality + the change to apply.

## Useful starting points

- `README.md` (root)
- `docs/architecture.md`, `docs/overview.md`, `docs/run-locally.md`, `docs/roadmap.md`
- `backend/CLAUDE.md`, `frontend/CLAUDE.md`
- `packages/*/CLAUDE.md`
- `backend/src/index.ts` — global router registration (the source of truth for "what endpoints exist")
- `backend/migrations/` — source of truth for "what columns exist"
- `git log --oneline -50` — recent commits give hints about what's likely drifted

## Delegate to

`Explore` agent (read-only, broad scan). Pass this file as the prompt; the agent's job is to compare each claim in the docs against the corresponding code path. No code edits.

Read-only. Findings only.
