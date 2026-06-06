---
description: Triage a failing Cypress run — pull its error, artifacts, captured failure context (command log / console / network / retries / resolved stack) and similar historical failures, then classify the failure (app error / network / selector drift / timing race / data collision) with a documented, provider-free heuristic. Writes findings to reviews/cypress-diag-<spec>.md.
argument-hint: "<runId> — a Flakey run id to diagnose (its first failing test, or pick one if several)"
---

Diagnose the failure in Flakey run `$ARGUMENTS` and classify it. The triage half of the Cypress story (`/cypress-repro` is the reproduction half).

## Usage

- `/cypress-diagnose 482` — diagnose run #482's failing test.

## Procedure

Use `${FLAKEY_API_URL:-http://localhost:3000}` and `Authorization: Bearer ${FLAKEY_API_KEY:-fk_demoadmindemoadmindemoadmindemoa}` for all calls (local seed key — see `backend/CLAUDE.md`; export real creds against a deployment). If the Flakey MCP server is wired up, the `get_test_artifacts` / `get_similar_failures` tools cover steps 2 and 4 directly.

1. **Find the failing test.** `GET /runs/<id>` → `{ specs: [{ file_path, tests: [{ id, full_title, status }] }] }`. Collect tests with `status === "failed"`. None failed → say so and stop. Several → take the first and note the rest (offer to diagnose them next); don't fan out silently.

2. **Pull the evidence.** `GET /tests/<testId>` (or the `get_test_artifacts` MCP tool). Extract:
   - `error_message`, `error_stack`
   - `command_log` — the `cy.*` tail (`[{ name, message, state }]`)
   - `failure_context` (Phase 13, Cypress only): `commands_tail`, `browser_console`, `uncaught_errors`, `network_failures`, `retry_errors`, **`resolved_stack`** + **`code_frame`** (the real spec line)
   - `screenshot_paths`, `video_path`

3. **Pull history.** `GET /tests/<testId>/history` → pass/fail timeline (last 50 runs). Compute the recent pass rate and the failed/total counts.

4. **Pull similar failures.** Find this error's fingerprint via `GET /errors` (match the group whose `error_message` + suite equals this test's), then `POST /analyze/similar/<fingerprint>` (or `get_similar_failures`). Lists historically similar failures across suites.

5. **Classify — documented heuristic, no LLM.** Apply in this priority order (first match wins); each rule names the exact signal it keys on:
   1. **`app-error`** — `failure_context.uncaught_errors` is non-empty, **or** `browser_console` contains an error-level line that looks like app code (a stack / `TypeError` / `ReferenceError`). A large share of Cypress reds are really a `window.onerror` in the app, not a bad test. Highest priority because it's the least ambiguous signal.
   2. **`network`** — `failure_context.network_failures` is non-empty (e.g. `POST /api/login → 500`). "The API failed," not "the element never appeared."
   3. **`selector-drift`** — no app/network signal, and `error_message` matches `/never found|failed to find|expected to find|Timed out retrying.*(get|find|contains)|cy\.(get|find|contains).*failed/i`. The locator no longer matches the DOM.
   4. **`timing-race`** — no app/network signal, and `error_message` matches `/timed out|timeout|did not (become|appear)|never (became|appeared|loaded)|retr(y|ied)/i`, and the `command_log`/`commands_tail` shows an action immediately before the wait that failed. A readiness race, not a missing element.
   5. **`data-collision`** — none of the above, and the history pass rate is strictly between ~30% and ~70% over **≥ 8** recent runs (intermittent with no selector/timing/app signal) — likely cross-run state in the shared fixture tenant. If history has < 8 runs, fall through to `unknown` and note the sample was too small to call.
   6. **`unknown`** — nothing fired. Report the raw evidence and ask for a human read.

6. **Write findings** to `reviews/cypress-diag-<spec-base-name>.md` (spec base name from `file_path`), with this shape:
   ```
   # cypress-diag/<spec> — run #<id>

   ## Run
   #<id> — <suite_name> — <branch> — <created_at>

   ## Failing test
   <file_path> — <full_title>

   ## Classification
   <class>: <which heuristic rule fired and on what signal>

   ## Evidence
   - Error: <error_message first line>
   - Resolved at: <code_frame.file>:<code_frame.line>   (from failure_context, if present)
   - Command tail: <last 3 commands_tail entries>
   - Console: <error-level browser_console lines, if any>
   - Network: <network_failures, if any>
   - Uncaught: <uncaught_errors, if any>
   - Retries: <retry_errors summary, if any>
   - Screenshots: <count> · Video: <yes/no>

   ## Historical context
   - Seen <N> times in last 50 runs — <pass>/<fail> (pass rate <pct>%)
   - Similar failures: <top 3 distinct error messages from /analyze/similar>

   ## Recommendation
   <one concrete next step keyed to the class — e.g. fix the selector, add a real
    readiness signal in the app, debug the app error at <code_frame location>,
    or check fixture-tenant isolation for a data collision>
   ```
   Use the repo status markers: `[ ]` open / `[x]` fixed / `[~]` deferred. Re-running overwrites the file.

7. **Relay the verdict** — a one-liner: `selector-drift` / `timing-race` / `app-error` / `network` / `data-collision` / `unknown`, plus the resolved spec line and the path to the written report. If the class is `app-error` or `network`, point at the offending code/endpoint, not the test.

## Notes

- **Provider-free first pass.** The classifier is the documented heuristic above — no AI call. For a deeper, model-driven classification + suggested fix, run the `analyze_error` MCP tool (gated behind `FLAKEY_MCP_ALLOW_MUTATIONS` — it writes an analysis record).
- **Fingerprint contract.** Error fingerprints are `md5(error_message + '|' + suite_name)`; that's what `/errors` exposes and `/analyze/similar/:fingerprint` consumes. If the fingerprinting changes, old fingerprints stop matching.
- **`resolved_stack`/`code_frame` need a recent reporter.** They're only present for Cypress runs uploaded by a `@flakeytesting/cypress-reporter` new enough to capture failure context. Older runs still classify — they just lack the resolved spec line.
- **Don't fix here.** This command classifies and reports. To reproduce, use `/cypress-repro <runId>`; fix at the source (root `CLAUDE.md` hard rule) once the class points you at the cause.
