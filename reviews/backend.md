# Review: backend/src/

## Scope
- Files reviewed: 63 (all non-dist, non-node_modules source files in `backend/`)
- Focus: bugs, misconfigurations, bad flows — security, data integrity, error handling, config
- Reviewer confidence: high — every source file was read in full; cross-references confirmed against migrations and index.ts mounting

---

## Priority: high

### H1. IDOR on `PATCH /orgs/:id/settings` — any org admin can overwrite any other org's settings
- **File(s)**: `backend/src/routes/orgs.ts:286-336`
- **Category**: security
- **Problem**: The handler checks `req.user!.orgRole === "viewer"` but never verifies that `req.params.id` equals `req.user!.orgId`. The `organizations` table has no RLS policy, so the bare `pool.query(UPDATE organizations ... WHERE id = $${i})` at line 326 will update whichever org ID is in the URL path. An admin of org 5 can overwrite the git token, retention policy, or git provider of org 1 by sending `PATCH /orgs/1/settings`.
- **Evidence**:
  ```ts
  // orgs.ts:287-330
  router.patch("/:id/settings", async (req, res) => {
    if (req.user!.orgRole === "viewer") { ... } // role check only, no id check
    ...
    params.push(req.params.id);               // URL-supplied id, not req.user!.orgId
    await pool.query(
      `UPDATE organizations SET ${sets.join(", ")} WHERE id = $${i}`,
      params
    );
  ```
- **Proposed change**:
  ```diff
  - params.push(req.params.id);
  - await pool.query(
  -   `UPDATE organizations SET ${sets.join(", ")} WHERE id = $${i}`,
  -   params
  - );
  + if (Number(req.params.id) !== req.user!.orgId) {
  +   res.status(403).json({ error: "Forbidden" });
  +   return;
  + }
  + params.push(req.user!.orgId);
  + await pool.query(
  +   `UPDATE organizations SET ${sets.join(", ")} WHERE id = $${i}`,
  +   params
  + );
  ```
  Apply the same guard to `GET /orgs/:id/settings` (line 269) and `GET /orgs/:id/members` (line 60) for the same reason — those also use `req.params.id` without an ownership check.
- **Risk if applied**: Low. The check is additive; legitimate callers always pass their own org id. The `GET /orgs/:id/members` change makes it return 403 instead of the members list for a foreign org.
- **Verification**: Start the server; create two orgs with separate accounts; attempt `PATCH /orgs/<other-org-id>/settings` — should receive 403 after fix, not 200.

---

### H2. `git_token` stored and used in plaintext — only Jira and PagerDuty keys are encrypted
- **File(s)**: `backend/src/routes/orgs.ts:307-309`, `backend/src/integrations/coverage-gate.ts:9-16`, `backend/src/routes/connectivity.ts:50-61`
- **Category**: security
- **Problem**: `PATCH /orgs/:id/settings` writes `git_token` directly from `req.body.git_token` with no call to `encryptSecret`. Reads in `coverage-gate.ts` and `connectivity.ts` use the raw column value with no `decryptSecret`. In contrast, `jira_api_token` (routes/jira.ts:41) and `pagerduty_integration_key` (routes/pagerduty.ts:39) both call `encryptSecret` on write and `decryptSecret` on read. A DB dump exposes all git provider tokens in cleartext.
- **Evidence**:
  ```ts
  // orgs.ts:307-309 — no encryptSecret
  if (req.body.git_token !== undefined) {
    sets.push(`git_token = $${i++}`);
    params.push(req.body.git_token || null);  // raw plaintext
  }

  // coverage-gate.ts:16 — no decryptSecret
  token: row.git_token,
  ```
- **Proposed change**:
  ```diff
  // orgs.ts write path
  - params.push(req.body.git_token || null);
  + params.push(req.body.git_token ? encryptSecret(req.body.git_token) : null);

  // coverage-gate.ts read path
  - token: row.git_token,
  + token: decryptSecret(row.git_token) ?? "",

  // connectivity.ts read path (line 61)
  - token: row.git_token,
  + token: decryptSecret(row.git_token) ?? "",
  ```
  Import `encryptSecret`/`decryptSecret` from `../crypto.js` in `orgs.ts` (already imported in `jira.ts` — follow the same pattern).
- **Risk if applied**: Existing stored tokens are plaintext. A one-time migration or the existing `rotate-keys` script pattern needs to be run against the `git_token` column. Until that migration runs, `decryptSecret` will pass plaintext through unchanged (it checks for the `v1:` prefix) so the app continues to work for existing rows.
- **Verification**: Set a git token via `PATCH /orgs/:id/settings`, then `SELECT git_token FROM organizations WHERE id = :id` — value should begin with `v1:`. Confirm connectivity test still passes.

---

### H3. `POST /live/:runId/events` has no run ownership check — cross-org event injection
- **File(s)**: `backend/src/routes/live.ts:94-133`
- **Category**: security
- **Problem**: The handler reads `orgId = req.user!.orgId` from the token but never queries the `runs` table to confirm that `runId` belongs to that org. Any authenticated user can POST to `/live/999/events` where 999 is another org's run. The SSE emitter (`liveEvents.emit`) fires immediately before any DB write, so subscribers watching run 999 receive injected events even though the subsequent DB inserts fail under RLS. This allows cross-org SSE stream poisoning.
- **Evidence**:
  ```ts
  // live.ts:94-118 — no ownership check before emit
  router.post("/:runId/events", async (req, res) => {
    const runId = Number(req.params.runId);
    const orgId = req.user!.orgId;
    // No SELECT 1 FROM runs WHERE id = $1 here
    ...
    liveEvents.emit(runId, fullEvent);       // fires before any DB check
    persistEvent(orgId, runId, fullEvent);   // RLS will reject wrong-org inserts silently
    res.json({ ok: true, ... });             // response sent
  ```
- **Proposed change**:
  Add a run ownership check at the top of the handler, mirroring the pattern already used in the snapshot endpoint (line 328):
  ```diff
  + const owns = await tenantQuery(orgId, "SELECT 1 FROM runs WHERE id = $1", [runId]);
  + if (!owns.rowCount) {
  +   res.status(404).json({ error: "Run not found" });
  +   return;
  + }
    liveEvents.emit(runId, fullEvent);
  ```
- **Risk if applied**: Adds one DB round-trip per event batch. The check is read-only and fast (PK lookup). Reporter clients that use an api key belonging to the correct org are unaffected.
- **Verification**: POST events to another org's run ID while authenticated as org A — should return 404 after fix. The SSE stream for that run should not receive the events.

---

### H4. Unhandled `JSON.parse` throws 500 on malformed multipart payload
- **File(s)**: `backend/src/routes/uploads.ts:33`
- **Category**: bug
- **Problem**: `JSON.parse(payloadStr)` is called with no `try/catch`. If `payloadStr` is not valid JSON, Node throws a `SyntaxError` that propagates to the outer `catch`, which logs it and returns `500 Internal Server Error`. The correct response for a bad client payload is 400. This also means malformed uploads can trigger error noise in production logs.
- **Evidence**:
  ```ts
  const body = JSON.parse(payloadStr);  // can throw SyntaxError
  ```
- **Proposed change**:
  ```diff
  - const body = JSON.parse(payloadStr);
  + let body: unknown;
  + try {
  +   body = JSON.parse(payloadStr);
  + } catch {
  +   res.status(400).json({ error: "Invalid JSON in payload field" });
  +   return;
  + }
  ```
- **Risk if applied**: None. The fix is purely additive error handling.
- **Verification**: POST to `/runs/upload` with `payload=not-json` — should return 400 after fix, not 500.

---

### H5. Multer temp files orphaned on DB/storage error path in `POST /runs/upload`
- **File(s)**: `backend/src/routes/uploads.ts:56-182`
- **Category**: bug
- **Problem**: Uploaded files land in `uploads/tmp/` via multer before the transaction begins. `storage.put()` calls `renameSync` (local) or uploads then deletes the tmp file (S3). If the transaction throws — or if any `storage.put()` call throws for the first file but not subsequent ones — the remaining tmp files are never cleaned up because there is no `finally` block that calls `rmSync` on each `file.path`. In the local storage mode, `uploads/tmp/` accumulates orphaned blobs indefinitely.
- **Evidence**:
  ```ts
  // uploads.ts:56-182 — no cleanup in catch or finally
  await tenantTransaction(orgId, async (client) => {
    ...
    for (const file of snapshotFiles) {
      await storage.put(file.path, relPath);  // if this throws midway, prior tmp files gone, later ones remain
    }
  });
  // catch(err): no file cleanup here
  ```
- **Proposed change**:
  Collect all multer file paths before the transaction, then clean up in a `finally`:
  ```diff
  + const allTmpPaths = [
  +   ...(screenshotFiles.map(f => f.path)),
  +   ...(videoFiles.map(f => f.path)),
  +   ...(snapshotFiles.map(f => f.path)),
  + ];
    await tenantTransaction(orgId, async (client) => { ... });
  + // no-op for already-moved files; rmSync with force:true is safe
  + finally {
  +   for (const p of allTmpPaths) {
  +     try { rmSync(p, { force: true }); } catch { /* ignore */ }
  +   }
  + }
  ```
  Import `rmSync` from `"fs"` (already available in `storage.ts`).
- **Risk if applied**: None. `force: true` on `rmSync` is a no-op for already-moved files.
- **Verification**: Send a multipart upload that fails mid-transaction (e.g., by temporarily breaking the DB connection); confirm `uploads/tmp/` is empty after the failed request.

---

## Priority: medium

### M1. `ALLOW_REGISTRATION` defaults to `true` — open self-registration in production unless explicitly disabled
- **File(s)**: `backend/src/routes/auth.ts:11`, `backend/.env.example:14`
- **Category**: security
- **Problem**: `ALLOW_OPEN_REGISTRATION = process.env.ALLOW_REGISTRATION !== "false"`. Any value other than the string `"false"` (including the env var being absent) enables open registration. The `.env.example` ships with `ALLOW_REGISTRATION=true`. For self-hosted deployments that want invite-only mode, an operator must affirmatively set `ALLOW_REGISTRATION=false` — the secure default is backwards. There is also no runtime warning when the server starts in production with open registration.
- **Evidence**:
  ```ts
  const ALLOW_OPEN_REGISTRATION = process.env.ALLOW_REGISTRATION !== "false";
  ```
- **Proposed change**:
  Flip the default so the environment variable must be explicitly set to enable open registration, and warn at startup:
  ```diff
  - const ALLOW_OPEN_REGISTRATION = process.env.ALLOW_REGISTRATION !== "false";
  + const ALLOW_OPEN_REGISTRATION = process.env.ALLOW_REGISTRATION === "true";
  ```
  In `index.ts`, alongside the existing `JWT_SECRET` prod check, add:
  ```diff
  + if (IS_PROD && ALLOW_OPEN_REGISTRATION) {
  +   console.warn("WARNING: ALLOW_REGISTRATION=true — open self-registration is enabled.");
  + }
  ```
  Update `.env.example` to comment out `ALLOW_REGISTRATION=true` (make the default a comment explaining the two choices).
- **Risk if applied**: Existing prod deployments that rely on open registration and have not set `ALLOW_REGISTRATION=true` will have registration disabled after the update. Operators must set `ALLOW_REGISTRATION=true` explicitly to preserve the current behavior. This is a breaking change; communicate in release notes.
- **Verification**: Start the server without `ALLOW_REGISTRATION` set; `POST /auth/register` should return 403. Set `ALLOW_REGISTRATION=true` and repeat — should return 201.

---

### M2. Session creation TOCTOU race — two concurrent requests can create duplicate active sessions
- **File(s)**: `backend/src/routes/releases.ts:1099-1196`
- **Category**: bug / data integrity
- **Problem**: The "forbid parallel sessions" check (`SELECT id FROM release_test_sessions WHERE release_id = $1 AND status = 'in_progress'`) runs outside of a transaction, and the subsequent `INSERT INTO release_test_sessions` is a separate statement. Two concurrent POST requests for the same release will both read zero active sessions, then both insert — creating two `in_progress` sessions. The rest of the release logic (readiness evaluation, session result recording) only handles one active session and uses `ORDER BY session_number DESC LIMIT 1`.
- **Evidence**:
  ```ts
  // releases.ts:1100-1108
  const active = await tenantQuery(
    req.user!.orgId,
    "SELECT id FROM release_test_sessions WHERE release_id = $1 AND status = 'in_progress'",
    [releaseId]
  );
  if (active.rows.length > 0) {
    res.status(409).json({ error: "An in-progress session already exists" });
    return;
  }
  // ... many more awaits before the INSERT
  const session = await tenantQuery(req.user!.orgId, `INSERT INTO release_test_sessions ...`);
  ```
- **Proposed change**:
  Wrap the check-and-insert in a `tenantTransaction`, or add a `unique partial index` on `(release_id) WHERE status = 'in_progress'` in a new migration and let the DB enforce uniqueness:
  ```sql
  -- new migration
  CREATE UNIQUE INDEX uniq_release_one_active_session
    ON release_test_sessions (release_id)
    WHERE status = 'in_progress';
  ```
  Then catch the `23505` unique-violation in the route handler and return 409.
- **Risk if applied**: The unique index approach is the safest — it enforces the invariant at the DB level. If there are already duplicate sessions in prod, the index creation will fail and need a cleanup step first.
- **Verification**: Send two simultaneous `POST /releases/:id/sessions` requests; only one should succeed (409 on the second) after the fix.

---

### M3. `POST /live/:runId/events` — async DB writes after response are unhandled; errors are silently swallowed
- **File(s)**: `backend/src/routes/live.ts:119-133`
- **Category**: error handling
- **Problem**: The response is sent (`res.json({ ok: true, ... })`) and then the handler continues executing awaited DB calls. If any of those DB writes throw (connection loss, RLS violation, etc.), the error propagates to the Express router's unhandled promise rejection handler and is logged, but the route handler already exited normally from Express's perspective. The real problem is that `upsertLiveSpec`, `insertLiveTestResult`, etc. each have internal `try/catch` that swallow errors — so DB write failures silently produce no spec/test rows, and the run page never shows live data, with no feedback to the reporter.
- **Evidence**:
  ```ts
  res.json({ ok: true, listeners: liveEvents.hasListeners(runId) });
  // If any of these throw, the error is completely hidden
  for (const fullEvent of fullEvents) {
    if (fullEvent.type === "spec.started") {
      await upsertLiveSpec(orgId, runId, fullEvent);
    }
    ...
  }
  ```
  Inside `upsertLiveSpec`:
  ```ts
  } catch (err: any) {
    console.error("Failed to upsert live spec:", err.message);  // logged only; caller never knows
  }
  ```
- **Proposed change**:
  The response-before-write pattern is intentional (to not block reporters). Keep it, but collect errors and expose them on the next request or via a structured log. At minimum, add a top-level catch on the async tail so unhandled rejection doesn't crash the process:
  ```diff
    res.json({ ok: true, listeners: liveEvents.hasListeners(runId) });
  
  + (async () => {
      for (const fullEvent of fullEvents) {
        if (fullEvent.type === "spec.started") await upsertLiveSpec(orgId, runId, fullEvent);
        ...
      }
  + })().catch(err => console.error("[live] post-response DB error:", err));
  ```
  This prevents any unhandled-rejection from reaching Node's global handler.
- **Risk if applied**: None. The change only adds error containment.
- **Verification**: Trigger a DB failure during a live run (e.g., kill the DB connection mid-stream); confirm the process does not crash and the error is logged.

---

### M4. `PATCH /orgs/:id/settings` — git token written unencrypted (also a duplicate of H2 cross-ref, see H2 for full details) and no org-ID ownership check (H1). Additionally, `GET /orgs/:id/settings` and `GET /orgs/:id/members` have the same missing ownership check as H1.
- **File(s)**: `backend/src/routes/orgs.ts:59-84` (members), `backend/src/routes/orgs.ts:268-283` (settings GET)
- **Category**: security
- **Problem**: `GET /orgs/:id/members` verifies membership (`SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`) so it is safe. `GET /orgs/:id/settings` does not check membership at all — any authenticated user can read the `git_provider`, `git_repo`, `git_base_url` fields (and confirm the presence of a git token) for any org ID.
- **Evidence**:
  ```ts
  // orgs.ts:268-283 — no membership check
  router.get("/:id/settings", async (req, res) => {
    const result = await pool.query(
      "SELECT retention_days, git_provider, git_repo, git_base_url, git_token IS NOT NULL ...",
      [req.params.id]  // any org id accepted
    );
    res.json(result.rows[0]);
  ```
- **Proposed change**:
  ```diff
  + if (Number(req.params.id) !== req.user!.orgId) {
  +   res.status(403).json({ error: "Forbidden" });
  +   return;
  + }
    const result = await pool.query(...);
  ```
- **Risk if applied**: None. Legitimate callers always fetch their own org.
- **Verification**: Fetch `/orgs/<foreign-org-id>/settings` — should return 403.

---

### M5. `POST /live/:runId/snapshot` — raw `testTitle` used in SQL `LIKE` pattern without escaping `%` and `_`
- **File(s)**: `backend/src/routes/live.ts:344-352`
- **Category**: bug
- **Problem**: The snapshot endpoint sanitizes `testTitle` for the filename (`safeTitle`), but the original unsanitized `testTitle` is used directly in the SQL `LIKE '%' || $2` pattern. A test title containing `%` or `_` will match unintended rows (e.g., `%` matches every `full_title` in the spec, linking the snapshot to all tests rather than just the intended one). This is a data-integrity bug, not an injection risk (the value is parameterized), but it corrupts snapshot associations at runtime.
- **Evidence**:
  ```ts
  const safeTitle = testTitle.replace(/[^a-zA-Z0-9_\- ]/g, "").replace(...)...;
  // ... but testTitle (not safeTitle) is passed to SQL:
  await tenantQuery(orgId,
    `UPDATE tests SET snapshot_path = $3
     FROM specs
     WHERE ... AND (tests.full_title = $2 OR tests.full_title LIKE '%' || $2)`,
    [runId, testTitle, key]  // testTitle, not safeTitle
  );
  ```
- **Proposed change**:
  Escape `%` and `_` in the LIKE operand, or use the sanitized title:
  ```diff
  - [runId, testTitle, key]
  + [runId, testTitle.replace(/%/g, "\\%").replace(/_/g, "\\_"), key]
  ```
  And update the query to include an `ESCAPE` clause: `LIKE '%' || $2 ESCAPE '\'`.
- **Risk if applied**: Tests with literal `%` or `_` in their title currently match spuriously; after the fix they match exactly. Any snapshot that was previously linked via the wrong-match path remains linked (this fix is not retroactive).
- **Verification**: Create a test titled "Login_Flow"; upload a snapshot with `testTitle=Login_Flow`; confirm only that one test gets the snapshot link, not all tests in the spec.

---

### M6. `retention.ts` interval injection — days value from DB concatenated into SQL string
- **File(s)**: `backend/src/retention.ts:20-21`
- **Category**: security / data integrity
- **Problem**: `retention_days` is cast to `Number` in the application but then `String(days)` is concatenated into the SQL as `($1 || ' days')::INTERVAL`. The `||` concatenation happens inside the query string before Postgres parses it, so `$1` is an unparameterized text. However, `days` is the result of `Number(org.retention_days)` and guarded with `if (!days || days <= 0) continue`, so it must be a positive number — which is safe. This is not exploitable in practice today because `retention_days` is only written by `PATCH /orgs/:id/settings` which validates it as `Number(req.body.retention_days)`. However, if the column is ever written directly via migration or seed and contains a non-numeric string, the cast will fail with an unhandled exception. The intent is to use a parameterized interval — the current approach does not achieve that.
- **Evidence**:
  ```ts
  const days = Number(org.retention_days);
  ...
  "DELETE FROM runs WHERE created_at < NOW() - ($1 || ' days')::INTERVAL RETURNING id",
  [String(days)]
  ```
- **Proposed change**:
  ```diff
  - "DELETE FROM runs WHERE created_at < NOW() - ($1 || ' days')::INTERVAL RETURNING id",
  - [String(days)]
  + "DELETE FROM runs WHERE created_at < NOW() - ($1 * INTERVAL '1 day') RETURNING id",
  + [days]
  ```
  This is a fully-parameterized interval with no string concatenation.
- **Risk if applied**: None. The behavior is identical for valid numeric values.
- **Verification**: Set `retention_days = 7`; confirm the query deletes runs older than 7 days; confirm `pg_stat_activity` shows no string concat in the query plan.

---

### M7. `badge` endpoint leaks data cross-org — public unauthenticated route queries across all orgs
- **File(s)**: `backend/src/routes/badge.ts:37-78`, `backend/src/index.ts:113`
- **Category**: security
- **Problem**: `/badge/:suiteName` is mounted as a public route (no `requireAuth`). It queries `runs` using `pool.query` with no RLS context and no org filter. Two different orgs that happen to use the same `suite_name` (e.g., `"e2e"` or `"regression"`) will receive the same badge data — the most recent run matching that suite name across the entire database. An external viewer can probe suite names to determine the pass/fail state of runs belonging to any org.
- **Evidence**:
  ```ts
  // index.ts:113 — no requireAuth
  app.use("/badge", badgeRouter);

  // badge.ts:41-44
  const result = await pool.query(
    `SELECT total, passed, failed, skipped FROM runs
     WHERE suite_name = $1
     ORDER BY created_at DESC LIMIT 1`,
    [suiteName]  // no org_id filter
  );
  ```
- **Proposed change**:
  The badge is intentionally public (for embedding in READMEs), but it must be scoped to an org. Change the route to include an org slug or API key:
  Option A — `/badge/:orgSlug/:suiteName` (readable, sharable):
  ```diff
  - router.get("/:suiteName", async (req, res) => {
  -   const { suiteName } = req.params;
  -   const result = await pool.query(
  -     `SELECT ... FROM runs WHERE suite_name = $1 ORDER BY created_at DESC LIMIT 1`,
  -     [suiteName]
  +   const { orgSlug, suiteName } = req.params;
  +   const org = await pool.query("SELECT id FROM organizations WHERE slug = $1", [orgSlug]);
  +   if (!org.rows[0]) { res.send(makeBadge("tests", "not found", "#9f9f9f")); return; }
  +   const result = await pool.query(
  +     `SELECT ... FROM runs WHERE suite_name = $1 AND org_id = $2 ORDER BY created_at DESC LIMIT 1`,
  +     [suiteName, org.rows[0].id]
  ```
- **Risk if applied**: Breaking URL change. Any existing badge embeds in external READMEs will 404 unless they include the org slug.
- **Verification**: Create two orgs with the same suite name, different run results; confirm `/badge/<org-a-slug>/e2e` returns org-A's badge, not org-B's.

---

### M8. `scheduleReports` lock is session-scoped but `lockClient` is released back to the pool before unlock
- **File(s)**: `backend/src/scheduled-reports.ts:21-79`
- **Category**: bug / data integrity
- **Problem**: `pg_try_advisory_lock` is session-scoped in Postgres — the lock is held for the duration of the connection, not the transaction. The code acquires the lock on `lockClient`, does work, then explicitly calls `pg_advisory_unlock` in the `finally` block before `lockClient.release()`. This is correct. However, if the `pg_advisory_unlock` call in `finally` throws (network blip, pool timeout), the `lockClient.release()` still runs, returning the connection to the pool — but the lock is NOT released because `pg_advisory_unlock` failed. The next caller gets a different connection from the pool and will not see the lock as held (advisory locks are per-session), so it acquires the lock again normally. This means the lock can fail to protect against concurrent execution if the unlock call fails — it just leaks the client holding the original lock until the connection closes. The `/* best effort */` comment acknowledges this but the behavior is silent and wrong.
- **Evidence**:
  ```ts
  finally {
    try {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [SCHEDULED_REPORTS_LOCK_KEY]);
    } catch {
      /* best effort */  // silent failure — lock leaked until connection drops
    }
    lockClient.release();
  }
  ```
- **Proposed change**:
  Use transaction-scoped advisory locks (`pg_try_advisory_xact_lock`) instead of session-scoped locks, then wrap the work in a transaction. Transaction-scoped locks auto-release when the transaction commits or rolls back, removing the need for an explicit unlock call:
  ```diff
  - const got = await lockClient.query<{ locked: boolean }>(
  -   "SELECT pg_try_advisory_lock($1) AS locked",
  - );
  - ...
  - try { await lockClient.query("SELECT pg_advisory_unlock($1)", [...]) } catch { }
  - lockClient.release();
  + await lockClient.query("BEGIN");
  + const got = await lockClient.query<{ locked: boolean }>(
  +   "SELECT pg_try_advisory_xact_lock($1) AS locked",
  + );
  + if (!got.rows[0]?.locked) { await lockClient.query("ROLLBACK"); lockClient.release(); return; }
  + ...
  + await lockClient.query("COMMIT");
  + lockClient.release();
  ```
- **Risk if applied**: The transaction wrapping means if any work inside throws and causes ROLLBACK, the lock is released early — but that is the correct behavior for a guard lock.
- **Verification**: Run two instances of the backend simultaneously pointing at the same DB; confirm only one sends reports per 30-minute window.

---

## Priority: low

### L1. Refresh token and access token share the same secret — no separation between token types at the signing key level
- **File(s)**: `backend/src/auth.ts:8,30-43`
- **Category**: security
- **Problem**: Both `signToken` (access) and `signRefreshToken` use `JWT_SECRET`. The `type: "refresh"` claim in the payload distinguishes them, and `verifyToken` rejects payloads where `type === "refresh"`. This works as long as the verification logic is correct and consistent. The risk is that any future code path that calls `jwt.verify` without checking the `type` field would accept a refresh token as an access token. Refresh tokens should have a separate secret or be stored server-side (opaque tokens). This is a design-level recommendation, not an active bug today.
- **Evidence**:
  ```ts
  const JWT_SECRET = process.env.JWT_SECRET ?? "flakey-dev-secret-change-me";
  export function signToken(user: AuthUser): string {
    return jwt.sign({ ...user }, JWT_SECRET, { expiresIn: ACCESS_EXPIRY });
  }
  export function signRefreshToken(userId: number): string {
    return jwt.sign({ id: userId, type: "refresh" }, JWT_SECRET, { expiresIn: REFRESH_EXPIRY });
  }
  ```
- **Proposed change**:
  Add a `REFRESH_SECRET` env var, defaulting to `JWT_SECRET + "-refresh"` in dev, required separately in prod, or implement opaque refresh tokens stored in a `refresh_tokens` DB table (enables server-side revocation). For the minimal fix:
  ```diff
  + const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? JWT_SECRET + "-refresh-dev";
    export function signRefreshToken(userId: number): string {
  -   return jwt.sign({ id: userId, type: "refresh" }, JWT_SECRET, ...);
  +   return jwt.sign({ id: userId, type: "refresh" }, REFRESH_SECRET, ...);
    }
  ```
  Update `verifyRefreshToken` and `POST /auth/refresh` to use `REFRESH_SECRET`.
- **Risk if applied**: Existing refresh tokens (in cookies) signed with `JWT_SECRET` become invalid. Users are logged out on next refresh. Acceptable if announced.
- **Verification**: Issue a refresh token; change `JWT_REFRESH_SECRET` to a new value; confirm `POST /auth/refresh` returns 401.

---

### L2. `POST /live/:runId/abort` has no run ownership check
- **File(s)**: `backend/src/routes/live.ts:364-377`
- **Category**: security
- **Problem**: Unlike the snapshot endpoint (which checks `SELECT 1 FROM runs WHERE id = $1`), the abort endpoint fires `abortRun(runId, orgId, reason)` with no prior ownership verification. An authenticated user from org A can abort org B's live run, emitting a `run.aborted` event on B's SSE stream and inserting an aborted event into `live_events`. The RLS policy on `live_events` will reject the DB insert (wrong org_id), but the in-memory SSE emit happens first.
- **Evidence**:
  ```ts
  router.post("/:runId/abort", (req, res) => {
    const runId = Number(req.params.runId);
    const orgId = req.user!.orgId;
    // No ownership check
    abortRun(runId, orgId, reason);  // emits immediately
    res.json({ ok: true });
  });
  ```
- **Proposed change**:
  Make the handler `async` and add:
  ```diff
  + const owns = await tenantQuery(orgId, "SELECT 1 FROM runs WHERE id = $1", [runId]);
  + if (!owns.rowCount) { res.status(404).json({ error: "Run not found" }); return; }
    abortRun(runId, orgId, reason);
  ```
- **Risk if applied**: None. One DB round-trip added.
- **Verification**: POST abort to another org's run ID — should return 404 after fix.

---

### L3. `PATCH /orgs/:id/members/:userId` allows owner to demote themselves if the URL userId matches their own but the business check excludes it — but the `admin` role is missing from the allowed values
- **File(s)**: `backend/src/routes/orgs.ts:216-265`
- **Category**: bug
- **Problem**: `PATCH /orgs/:id/members/:userId` validates `role` as `["admin", "viewer"]` but the org role model also has `"owner"`. The intent is that owners can promote admins/viewers to admin but not to owner (that would be a separate promote-to-owner flow). However, an owner can demote another admin to `viewer` but has no way through this endpoint to promote a `viewer` to `owner` — that's by design. What is a bug: line 222 rejects any role not in `["admin", "viewer"]`, so if a future caller tries to set `"owner"` it gets a generic 400 instead of a meaningful 403. This is a minor UX issue, not a security bug, but it produces confusing error messages.
- **Evidence**:
  ```ts
  if (!role || !["admin", "viewer"].includes(role)) {
    res.status(400).json({ error: "Role must be 'admin' or 'viewer'" });
    return;
  }
  ```
- **Proposed change**:
  ```diff
  - if (!role || !["admin", "viewer"].includes(role)) {
  -   res.status(400).json({ error: "Role must be 'admin' or 'viewer'" });
  + if (!role || !["admin", "viewer", "owner"].includes(role)) {
  +   res.status(400).json({ error: "Role must be 'admin', 'viewer', or 'owner'" });
  + }
  + if (role === "owner") {
  +   res.status(403).json({ error: "Promoting to owner is not supported via this endpoint" });
    return;
  }
  ```
- **Risk if applied**: None.
- **Verification**: Send `PATCH /orgs/:id/members/:userId` with `role: "owner"` — should return a specific 403 rather than a generic 400.

---

### L4. `POST /reports/:id/run` — resets `last_sent_at` to NULL then calls `runScheduledReports` in-process; if the scheduler is currently running it will execute the report twice
- **File(s)**: `backend/src/routes/reports.ts:151-169`
- **Category**: bug
- **Problem**: The "run now" handler sets `last_sent_at = NULL` then immediately calls `runScheduledReports()`. The scheduled-reports function tries to acquire a Postgres advisory lock; if the background interval also fired at the same moment and holds the lock, `runScheduledReports` returns without sending the report. The `last_sent_at` remains NULL, so the next background run will pick it up again. The behavior is inconsistent: sometimes the report fires twice (once via this handler, once via the background interval before this request set `last_sent_at = NULL`), sometimes zero times (if background holds the lock and updates `last_sent_at` between the NULL set and the in-handler execution).
- **Evidence**:
  ```ts
  await tenantQuery(req.user!.orgId,
    "UPDATE scheduled_reports SET last_sent_at = NULL WHERE id = $1", [req.params.id]
  );
  await runScheduledReports();  // may no-op due to lock; last_sent_at stays NULL
  ```
- **Proposed change**:
  Bypass the scheduler entirely and call `deliverReport` directly (exposing it as an export from `scheduled-reports.ts`), then update `last_sent_at` explicitly after delivery:
  ```diff
  - await tenantQuery(req.user!.orgId,
  -   "UPDATE scheduled_reports SET last_sent_at = NULL WHERE id = $1", [req.params.id]
  - );
  - await runScheduledReports();
  + const { deliverReportById } = await import("../scheduled-reports.js");
  + await deliverReportById(req.user!.orgId, Number(req.params.id));
  ```
  Export `deliverReportById(orgId, reportId)` from `scheduled-reports.ts` wrapping the existing `deliverReport` internal function.
- **Risk if applied**: Removes a read-then-run indirection and makes the on-demand run explicit. No lock contention.
- **Verification**: Trigger `POST /reports/:id/run` while the background scheduler is running — confirm the report is delivered exactly once.

---

### L5. `findOrCreateRun` in `run-merge.ts` has a TOCTOU race for concurrent uploads with the same `ci_run_id`
- **File(s)**: `backend/src/run-merge.ts:18-27`
- **Category**: data integrity
- **Problem**: `findOrCreateRun` runs a `SELECT ... WHERE ci_run_id = $1` followed by an `INSERT` in separate statements (not wrapped in the same transaction snapshot). Two concurrent uploads with the same `ci_run_id` will both see no existing run and both attempt to insert, causing a unique constraint error on the second insert (assuming a unique constraint exists on `ci_run_id + suite_name + org_id`). The caller's `tenantTransaction` wraps this, but the `SELECT` and `INSERT` are separate statements within the same transaction — Postgres uses read-committed by default, so the second concurrent transaction can see the first's committed insert. However, if there is no unique constraint, both inserts succeed and the run is duplicated.
- **Evidence**:
  ```ts
  const existing = await client.query(
    `SELECT id FROM runs WHERE ci_run_id = $1 AND suite_name = $2 AND org_id = $3`,
    ...
  );
  if (existing.rows.length > 0) return { runId: existing.rows[0].id, merged: true };
  // INSERT follows — no ON CONFLICT clause
  const result = await client.query(`INSERT INTO runs (...) ...`);
  ```
- **Proposed change**:
  Use `INSERT ... ON CONFLICT (ci_run_id, suite_name, org_id) DO NOTHING RETURNING id`, then fall back to a `SELECT` if the insert was a no-op. This is the standard atomic upsert pattern and matches what migration 030 did for `specs`.

  Verify first whether a unique constraint exists on `runs(ci_run_id, suite_name, org_id)`. If not, add one in a migration, then:
  ```diff
  - const existing = await client.query(`SELECT id FROM runs WHERE ci_run_id = $1 ...`);
  - if (existing.rows.length > 0) return { runId: existing.rows[0].id, merged: true };
  - const result = await client.query(`INSERT INTO runs (...) RETURNING id`);
  - return { runId: result.rows[0].id, merged: false };
  + const result = await client.query(
  +   `INSERT INTO runs (...) ON CONFLICT (ci_run_id, suite_name, org_id) DO NOTHING RETURNING id`,
  +   ...
  + );
  + if (result.rows[0]) return { runId: result.rows[0].id, merged: false };
  + const existing = await client.query(`SELECT id FROM runs WHERE ci_run_id = $1 ...`);
  + return { runId: existing.rows[0].id, merged: true };
  ```
- **Risk if applied**: Requires confirming or adding a unique constraint first. Without the constraint, the `ON CONFLICT` clause references nothing and fails to compile.
- **Verification**: Send two simultaneous `POST /runs` requests with the same `ci_run_id` — should result in exactly one run row, not two.

---

## Nothing to flag

N/A — issues were found.
