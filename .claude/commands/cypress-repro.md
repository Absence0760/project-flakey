---
description: Deterministically reproduce a failing Cypress spec against examples/cypress — retries OFF, video ON — so a flake shows its true rate instead of being papered over by Cypress's own retry. Resolves the spec from a Flakey run id or takes a spec path directly.
argument-hint: "[runId | spec path] — a Flakey run id (numeric) or a cypress/e2e/**/*.cy.ts path"
---

Reproduce `$ARGUMENTS` deterministically with the Cypress example suite. The Cypress counterpart to `/flake-doctor` (which is Playwright-only).

## Usage

- `/cypress-repro 482` — resolve the failing spec(s) from Flakey run #482 and re-run them.
- `/cypress-repro cypress/e2e/smoke/todos.cy.ts` — run a known spec path directly.

## Procedure

1. **Resolve the target.** `$ARGUMENTS` is one of:
   - **A numeric run id** — fetch the run and pull its failing spec(s):
     ```
     curl -s -H "Authorization: Bearer ${FLAKEY_API_KEY:-fk_demoadmindemoadmindemoadmindemoa}" \
       "${FLAKEY_API_URL:-http://localhost:3000}/runs/<id>"
     ```
     The response is `{ suite_name, specs: [{ file_path, tests: [{ status, ... }] }] }`. Take the specs with at least one `status === "failed"` test. The `SUITE` to run with is `suite_name` minus the `cypress-example-` prefix (e.g. `cypress-example-smoke` → `smoke`). Multiple failing specs → list them and confirm which to take first; **don't fan out silently**.
   - **A spec path** under `examples/cypress/cypress/e2e/**` — use as-is. Infer `SUITE` from the path's first dir under `e2e/` (`smoke`, `sanity`, `regression`, `live`, `a11y`, `flaky`).

2. **Bring up the app under test** (the example specs hit a real app on `:4444`):
   ```
   cd examples/shared && pnpm start      # serves http://localhost:4444
   ```
   The backend (`:3000`) only needs to be up if you want the repro to *upload* its result (`pnpm db:up` + `cd backend && ./migrate.sh && npm run seed && npm run dev`). For a pure local repro you can skip it — Cypress runs regardless; the reporter's upload just no-ops without a reachable backend.

3. **Run deterministically — retries OFF, video ON:**
   ```
   cd examples/cypress && SUITE=<suite> pnpm exec cypress run \
     --spec <file_path> \
     --config retries=0,video=true
   ```
   - `retries=0` is the point: Cypress's default in-run retry hides a flake's true rate. Off, a flake fails honestly.
   - `video=true` (the config default, set explicitly here) writes `cypress/videos/<spec>.mp4` for inspection.
   - To measure a flake rate, loop the same command N times and count reds — **do not** add `--retries`, `cy.wait(ms)`, or inflate timeouts to make it pass (root `CLAUDE.md` hard rule).

4. **Report.** Surface: the spec(s) run, the exact command, pass/fail, the video path, and the failing assertion. If it failed, suggest `/cypress-diagnose <runId>` to classify the failure; if it's intermittent across loops, say so with the observed rate.

## Notes

- **Deterministic, not masked.** This command's whole job is to remove Cypress's retry cushion. If a spec only passes with retries on, that *is* the bug — diagnose it, don't restore the cushion.
- **Auth.** Local dev seeds a known admin key `fk_demoadmindemoadmindemoadmindemoa` (see `backend/CLAUDE.md`); the fallback above uses it. Against a real deployment, export `FLAKEY_API_KEY` / `FLAKEY_API_URL` first.
- **Spec not found?** A run's `file_path` is recorded as the reporter saw it. If it doesn't exist on disk (renamed/moved spec, stale run), `ls examples/cypress/cypress/e2e/<suite>/` and confirm with the operator rather than guessing.
- This is reproduction only — it doesn't classify or fix. Pair it with `/cypress-diagnose`.
