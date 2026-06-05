---
description: Triage and source-fix a flaky/failing Playwright e2e test. Brings up the full stack, resolves the target (spec path / CI run / the currently-red shard), then delegates to the `flake-doctor` agent — which finds the root cause, fixes the app (or the test if the test is the bug), and verifies. Never masks a flake with sleeps, retries, or inflated timeouts.
argument-hint: "[spec path | CI run URL | 'red e2e'] — what to triage (empty = the currently-failing e2e on the latest CI run / working tree)"
---

Triage `$ARGUMENTS` with project-flakey's `flake-doctor` agent and fix it at the source.

## Usage

- `/flake-doctor frontend/tests-e2e/runs/runs.spec.ts` — a specific spec.
- `/flake-doctor frontend/tests-e2e/runs/runs.spec.ts:42` — a single test by line.
- `/flake-doctor https://github.com/<org>/project-flakey/actions/runs/<id>` — pull the failing test(s) from a CI run.
- `/flake-doctor` — auto-detect: read the latest CI run's red e2e shard, fall back to the working tree if CI is green.

## Procedure

1. **Resolve the target.** `$ARGUMENTS` is one of:
   - **A spec path** (optionally `:line`) under `frontend/tests-e2e/**` — used as-is. Specs live in subdirs (`runs/`, `flaky/`, `errors/`, `releases/`, `live/`, `compare/`, `slowest/`, `dashboard/`, `cross-cutting/`, …); `ls frontend/tests-e2e/` if you need to disambiguate a bare name.
   - **A GitHub Actions run URL** — `gh run view <id> --log-failed` (or pull the failed-jobs annotations) to extract the failing spec(s) and the assertion that blew up. Multiple reds → list them and confirm which to take first; don't fan out silently.
   - **Empty / `red e2e`** — `gh run list --workflow=claude.yml -L 5` (and any e2e workflow) to find the latest run with a failing e2e shard, then extract the spec. If CI is green, fall back to whatever's failing in the working tree.

2. **Bring up the stack** (the e2e run needs real services — there is no mock layer):
   - `pnpm db:up` — docker-compose Postgres.
   - Backend migrate + seed + run, from `backend/`:
     ```
     cd backend && ./migrate.sh && npm run seed && npm run dev
     ```
     (`migrate.sh` applies `backend/migrations/NNN_*.sql` in order; `seed` loads the deterministic fixture tenant; `dev` is `tsx watch` on :3000. Backend uses **npm**, not pnpm.)
   - Frontend dev on :7778 if the spec drives a live page rather than `webServer`-managed — check `frontend/tests-e2e/playwright.config.ts` first; if it owns `webServer`, let Playwright start it.
   - Confirm the admin storageState exists at `frontend/tests-e2e/.auth/admin.json`; if missing, run the playwright auth setup once.

3. **Delegate to the `flake-doctor` agent.** Spawn it with the resolved target as the **first sentence** of the prompt, e.g.:

   > "Triage `frontend/tests-e2e/runs/runs.spec.ts` (failing assertion: `<paste the assertion / error from the CI log or local run>`). Find the root cause, fix it at the source per your spec, then verify. The stack is up (db + backend :3000 + frontend :7778). Do not commit."

   The agent reproduces the failure, isolates the root cause (app bug, missing readiness signal, or a genuinely-broken test/fixture), applies the **source** fix, writes its findings to `reviews/flake-<scope>.md`, and re-runs to confirm green. Trust its spec — don't narrate its internal steps.

4. **Verify locally** with the same command the agent uses, so the operator can re-run it:
   ```
   pnpm exec playwright test --config=tests-e2e/playwright.config.ts <spec> --project=chromium
   ```
   (run from `frontend/`). For a single test, append `:line` or `-g "<title>"`.

5. **Relay the agent's report.** Surface the root-cause one-liner, the files changed (`git diff --stat`), the path to `reviews/flake-<scope>.md`, and the verifying run's result. Then ask the operator whether to commit.

## Notes

- **Fix at the source, never mask** — the project's hard rule (root `CLAUDE.md`) binds the agent and this command. Forbidden "fixes": inflating an `expect`/`toBeVisible` timeout to absorb a flake, `page.waitForTimeout(N)` between actions, bumping `--retries`, loosening a strict assertion (`toHaveText` → `toContainText(/.*/)`), or `test.skip`/`fixme` against a real bug without a named follow-up. If the page is slow or the signal is unreliable, fix *that* — add a real readiness affordance (a `data-ready` attr backed by an actual signal, an exposed status) in the app code, not test scaffolding.
- **The agent does not commit.** The operator reviews `git diff` + `reviews/flake-<scope>.md` and commits (path-scoped, no `Co-Authored-By`/"Generated with" footer). Suggest a `fix(...)` or `test(...)` message; don't pre-stage.
- **Status markers** in `reviews/flake-<scope>.md` follow the repo convention: `[ ]` open / `[x]` fixed / `[~]` deferred. Re-running overwrites the file.
- **Optional polluted-tenant robustness check.** Flakes that vanish on a fresh seed but recur in CI are often cross-run state in the shared fixture tenant — the seed isn't fully deterministic, or the test assumes counts that another spec mutates. The backend is multi-tenant via Postgres RLS (`tenantQuery`/`tenantTransaction` in `backend/src/db.ts`, `org_id` scope from `004_multi_tenancy.sql`); if a test reads denormalized `runs`/`specs`/`tests` counts, confirm it scopes to its own org and doesn't depend on global ordering. Re-run against a `pnpm db:reset`-ed + re-seeded DB to confirm the fix isn't just papering over fixture pollution.
- This is **not** `/check` (pre-commit gate) or a broad `/audit/*` sweep — it's a single red test, end to end.
