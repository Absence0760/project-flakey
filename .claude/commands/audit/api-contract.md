---
description: Audit the hand-synced request/response contract between the Express routes and frontend/src/lib/api.ts — drift that compiles but breaks at runtime
---

Audit the request/response contract between the Express routes (`backend/src/routes/*.ts`, registered in `backend/src/index.ts`) and the frontend client (`frontend/src/lib/api.ts`), with shared shapes in `backend/src/types.ts`, for drift that compiles cleanly but breaks at runtime.

## Goal

There is **no codegen** in this monorepo. Every request/response shape is hand-synced across three places: the route handler that builds the JSON, the `frontend/src/lib/api.ts` interface that types it, and (transitively) the DB columns the route selects. When those drift, TypeScript stays green — the frontend declares a field, the route just never returns it, and the consumer reads `undefined` at runtime; or a route renames/drops a field and the typed client silently loses it. This audit hunts that route↔client gap: does every `api.ts` function hit a real route with the params it sends, does every response interface field actually appear in the route's `SELECT`/returned object, and do status-code/enum/pagination assumptions match on both sides.

This is the *contract* audit, distinct from `/audit/migrations`, which already covers DB-column type-drift (a column added to the schema but not to `types.ts`/`api.ts`, `TIMESTAMP` vs `string`, enum/CHECK sync against the DB). **Do not re-report schema↔type column drift here** — that's `/audit/migrations`' job. Focus strictly on the route handler's emitted shape versus the `api.ts` client's expectation: a field the type declares that the route's actual SELECT/object never produces, a request param the client sends that the route ignores, a path/method mismatch, a status code the client branches on that the route never emits. Cross-reference and move on.

## What to check

Read `frontend/src/lib/api.ts` end-to-end and open each route it calls — the findings live in the diff between the two.

1. **Every `api.ts` function maps to a real route (method + path + params).** For each exported function (`fetchRuns`→`GET /runs`, `fetchRunsWithSummary`→`GET /runs?limit&offset`, `fetchRun`→`GET /runs/:id`, `fetchEnvironments`→`GET /runs/environments`, `fetchFlakyTests`→`GET /flaky`, `fetchSlowestTests`→`GET /tests/slowest/list`, `updateErrorStatus`→`PATCH /errors/:fingerprint/status`, etc.), confirm the route exists at that exact path+method in the matching `backend/src/routes/*.ts` and is mounted under the prefix in `index.ts`. Flag a client call to a path that no route serves (404 at runtime), a method mismatch (client `PATCH` vs route `PUT`), and a route segment ordering trap — e.g. `GET /runs/environments` must be declared *before* `GET /runs/:id` or `:id` swallows `"environments"`.

2. **Every response-interface field exists in the route's actual returned object.** For each interface (`Run`, `RunDetail`, `Spec`, `TestResult`, `TestDetail`, `ErrorGroup`, `FlakyTest`, `SlowestTest`, `DashboardStats`, `CompareEntry`, `SuiteComparison`, `TrendsData`, …), walk its fields against the route's `SELECT` column list / `json_agg` / response object literal. A field on the type with no matching selected column or object key is read as `undefined` at runtime. Concrete watch-list: `Run.spec_count`, `Run.spec_files`, `Run.new_failures`, `Run.aborted` — these are computed/joined, not base `runs` columns, so confirm the `/runs` query actually produces each. `FlakyTest.flip_count`/`flaky_rate`/`timeline`/`run_ids` come out of the `flaky.ts` CTE aggregation — confirm each alias is in the final `SELECT`.

3. **`*Detail` vs base shapes — extra fields are really returned.** `RunDetail extends Run` and adds `specs`, `rerun_command_template`, `prev_id`, `next_id`, `aborted_reason`; `TestDetail extends TestResult` and adds `file_path`, `run_id`, `spec_title`, `prev_failed_id`, `next_failed_id`, `failed_index`, `failed_total`. Confirm `GET /runs/:id` and `GET /tests/:id` each return *both* the base fields and the extras (the detail SELECT/assembly must not drop a base field the list path provides). Flag any `extends` field the detail route doesn't actually emit.

4. **Nullability honesty.** Where the type says `| null` (e.g. `TestResult.error_message`, `video_path`, `snapshot_path`, `RunDetail.prev_id`/`next_id`, `CompareEntry.a`/`b`), confirm the route can actually produce `null` there — and conversely, where the type is non-nullable (e.g. `Run.environment: string`, justified in `api.ts:49-52` by the `NOT NULL DEFAULT ''` column), confirm the route never emits `null`/omits it via a `LEFT JOIN` that can null it out. A `LEFT JOIN` feeding a non-nullable typed field is a finding.

5. **Status-code handling matches what routes emit.** `authFetch` (`frontend/src/lib/stores/auth.ts`) does the one-shot 401 refresh; individual `api.ts` functions branch on `res.ok` and some swallow errors (`fetchSavedViews`/`fetchQuarantinedTests`/`findSimilarErrors` return `[]` on non-ok, `checkAIEnabled` returns `false`). Confirm those swallow-to-empty paths match routes that can legitimately 404/403 for a normal user, and that a client expecting a specific code (401 → refresh, 403 → forbidden, 404 → not-found) lines up with what the route emits — e.g. `requireRunOwnership` in `index.ts` returns **404** ("Artifact not found"), not 403, for a cross-org artifact; a client treating that as 403 would misroute.

6. **Request params the client sends are honored server-side.** Cross-check query/body params against the handler. `fetchFlakyTests` sends `limit=200` and the comment claims the backend caps at 200 — verify `flaky.ts:12` actually does `Math.min(Number(req.query.limit) || 50, 200)` (and `runs`→`Math.min(..., 100)` at line 11). `fetchSlowestTests` sends `limit=100` claiming a cap in `tests.ts` — verify it. `fetchRunsWithSummary` sends `limit`/`offset` — confirm `runs.ts` reads both and returns `{ runs, summary, hasMore }` matching the function's declared return. Flag a param the client sends that the route ignores (silent no-op pagination/filter), and a cap comment in `api.ts` that disagrees with the route's actual `Math.min`.

7. **Enum unions identical across the two contract files.** The `tests.status` union `"passed" | "failed" | "skipped" | "pending"` appears as a typed literal in `TestResult.status` (`api.ts`) and `NormalizedTest.status` (`types.ts:48`). Confirm they're character-identical and that routes never emit a status outside the union into a field typed as the union. (The DB CHECK side of this is `/audit/migrations`/`/audit/schema-design`; here only confirm the two TS files agree and the route's output respects the union.) Likewise stringly-typed-but-typed-as-`string` fields (`ErrorGroup.status`, `Note.target_type`, `SavedView.page`) — note where the client hard-codes/sends a value set the route must accept.

8. **Request-body shapes the client POSTs/PATCHes match the handler's destructure.** For `addNote`, `createSavedView`, `quarantineTest`, `analyzeFlakyTest`, `updateErrorStatus`, etc., confirm the JSON body keys the client sends (`{ target_type, target_key, body }`, `{ fullTitle, filePath, suiteName, reason }`, …) are the exact keys the route reads off `req.body`. A camelCase/snake_case mismatch (`fullTitle` vs `full_title`) between client body and route destructure is a silent `undefined` insert — a real runtime bug.

## Report

Group by severity. For this audit:

- **High** — a contract break a user hits at runtime: a typed field the route never returns (renders `undefined`/blank), a request param the client relies on that the route ignores (broken pagination/filter), a body-key case mismatch that inserts `undefined`, a path/method mismatch that 404s, or a client status-code branch that disagrees with what the route emits.
- **Medium** — nullability dishonesty (type says non-null but a `LEFT JOIN` can null it, or vice-versa); a `*Detail extends *` field the detail route doesn't emit; an enum union that's drifted between `api.ts` and `types.ts`; a cap/comment in `api.ts` that contradicts the route's actual `Math.min`.
- **Low** — a swallow-to-empty error path that masks a real route error a user should see; a stringly-typed contract field where a shared union would prevent future drift; cosmetic param naming that works today but invites a mismatch.

For each finding: the `api.ts` interface/function + the route `file:line` (both sides of the drift), what runtime symptom it produces (e.g. "`Run.spec_files` is `undefined` because `/runs` selects no such alias → the file pills never render"), and the fix on the correct side (add the missing SELECT column / honor the param / correct the type / align the body key). Name which file changes — this is hand-synced, so most fixes touch either the route or `api.ts`, not both.

## Useful starting points

- `frontend/src/lib/api.ts` — every client function + response/request interface (the expectation side)
- `frontend/src/lib/stores/auth.ts` — `authFetch`'s 401-refresh behavior the status-code checks ride on
- `backend/src/index.ts` — route prefixes + which are public (`/health`, `/auth/login`, `/auth/register`, `/badge`) vs `requireAuth`-gated
- `backend/src/routes/runs.ts`, `routes/flaky.ts`, `routes/tests.ts`, `routes/errors.ts`, `routes/compare.ts`, `routes/stats.ts` — the routes behind the most-typed client functions
- `backend/src/types.ts` — `NormalizedRun`/`NormalizedSpec`/`NormalizedTest` and the `status` union the client must match

## Delegate to

Use the `flakey-auditor` agent: `"Audit the request/response contract between the Express routes and frontend/src/lib/api.ts — find typed fields a route never returns, params the client sends that routes ignore, body-key mismatches, path/method/status drift, and enum-union skew. Write the report to reviews/api-contract.md."` Read-only on the codebase — the deliverable is the findings report at **`reviews/api-contract.md`**, not applied changes.
