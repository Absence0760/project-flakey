import { Router } from "express";
import crypto from "crypto";
import multer from "multer";
import { tenantQuery } from "../db.js";
import { liveEvents, type LiveTestEvent } from "../live-events.js";
import { getStorage } from "../storage.js";

const router = Router();
const snapshotUpload = multer({ dest: "uploads/tmp", limits: { fileSize: 50 * 1024 * 1024 } });
const screenshotUpload = multer({ dest: "uploads/tmp", limits: { fileSize: 25 * 1024 * 1024 } });

/**
 * GET /live/active — list run IDs that are currently receiving live events.
 */
router.get("/active", (req, res) => {
  // Scope to the caller's org — without this, any authenticated user
  // can enumerate every other org's in-progress run ids.
  res.json({ runs: liveEvents.getActiveRunIds(req.user!.orgId) });
});

/**
 * GET /live/stream — org-scoped SSE for active-run-set deltas.
 *
 * Replaces the dashboard's 5 s /live/active polling loop (roadmap
 * Phase 12 / issue #41). On connect the server sends a `snapshot`
 * event with the current active-run ids for the caller's org, then
 * streams `active.add` / `active.remove` deltas as runs enter or
 * leave the active set.
 *
 * Auth: same token-via-query mechanism as /live/:runId/stream — the
 * router-prefix middleware in index.ts promotes ?token=... to a
 * Bearer header before requireAuth runs. EventSource on the browser
 * side can't set headers, hence the query-param fallback.
 *
 * Tenancy: getActiveRunIds(orgId) filters by runMeta orgId, and
 * subscribeOrg keys its emitter on orgId, so a subscriber for org A
 * never receives deltas for runs in org B.
 */
router.get("/stream", (req, res) => {
  const orgId = req.user!.orgId;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });

  // Initial snapshot so the client can render in-progress runs
  // immediately on connect / reconnect, then react to deltas.
  res.write(`data: ${JSON.stringify({
    type: "snapshot",
    runs: liveEvents.getActiveRunIds(orgId),
  })}\n\n`);

  const unsubscribe = liveEvents.subscribeOrg(orgId, (delta) => {
    res.write(`data: ${JSON.stringify(delta)}\n\n`);
  });

  // Keep-alive every 15 s (matches the per-run /live/:runId/stream
  // cadence). Comment-only line so proxies and EventSource itself
  // ignore it but the TCP connection stays warm.
  const keepAlive = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);

  req.on("close", () => {
    unsubscribe();
    clearInterval(keepAlive);
  });
});

/**
 * POST /live/start — create (or resume) a placeholder run for live tracking, returns the run ID.
 * Body: { suite, branch?, commitSha?, ciRunId? }
 *
 * Idempotent on (org_id, suite_name, ci_run_id) via the partial unique
 * index uniq_runs_ci_run (migration 035). A reporter that restarts
 * after a crash, or a CI job that retries with the same CI run id,
 * re-enters the same run row instead of either creating a duplicate
 * (no constraint) or 500'ing on a unique violation (with constraint
 * but no upsert). When ciRunId is omitted the route generates a
 * random one — guaranteed unique, so the upsert always inserts.
 *
 * Response includes `resumed: true` when the row already existed so
 * a reporter knows whether it just allocated a fresh run or attached
 * to an in-flight one.
 */
router.post("/start", async (req, res) => {
  try {
    const { suite, branch, commitSha, ciRunId, environment } = req.body;
    if (!suite) {
      res.status(400).json({ error: "suite is required" });
      return;
    }

    const orgId = req.user!.orgId;
    // Generate a ci_run_id so the main reporter's upload merges into this run
    const effectiveCiRunId = ciRunId || `live-${crypto.randomBytes(8).toString("hex")}`;
    const env = typeof environment === "string" ? environment.trim() : "";

    // ON CONFLICT against the partial unique index lets a repeat
    // /live/start with the same (org, suite, ci_run_id) return the
    // existing row's id instead of failing. The DO UPDATE is a
    // deliberate no-op set so RETURNING fires on the conflict path.
    // xmax = 0 distinguishes inserted-now from already-existed.
    const result = await tenantQuery(orgId,
      `INSERT INTO runs (suite_name, branch, commit_sha, ci_run_id, reporter, started_at, finished_at, total, passed, failed, skipped, pending, duration_ms, org_id, environment)
       VALUES ($1, $2, $3, $4, 'live', NOW(), NOW(), 0, 0, 0, 0, 0, 0, $5, $6)
       ON CONFLICT (org_id, suite_name, ci_run_id) WHERE ci_run_id <> ''
       DO UPDATE SET reporter = runs.reporter
       RETURNING id, (xmax = 0) AS inserted`,
      [suite, branch ?? "", commitSha ?? "", effectiveCiRunId, orgId, env]
    );

    const runId = result.rows[0].id;
    const resumed = !result.rows[0].inserted;
    // registerRun is idempotent (it just overwrites runMeta), so a
    // resumed run gets its stale-timer reset, which is what we want
    // if the reporter is actively attaching again.
    liveEvents.registerRun(runId, orgId);
    liveEvents.emit(runId, { type: "run.started", runId, timestamp: Date.now() });

    // Persist the start event
    persistEvent(orgId, runId, { type: "run.started", runId, timestamp: Date.now() });

    res.status(201).json({ id: runId, ci_run_id: effectiveCiRunId, resumed });
  } catch (err) {
    console.error("POST /live/start error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /live/:runId/history — get persisted live events for a run (survives refresh).
 */
router.get("/:runId/history", async (req, res) => {
  try {
    const runId = Number(req.params.runId);
    if (!runId) {
      res.status(400).json({ error: "Invalid run ID" });
      return;
    }

    // Match the rest of /live/* — confirm the run is in the caller's
    // org BEFORE running the query. RLS already strips foreign rows so
    // the SELECT below is harmless without this check, but the response
    // status code (200 [] vs 404) leaks run-id validity across tenants.
    // Returning 404 here makes existence indistinguishable from absence,
    // matching POST /events, /abort, /screenshot, /stream.
    const owns = await tenantQuery(req.user!.orgId, "SELECT 1 FROM runs WHERE id = $1", [runId]);
    if (!owns.rowCount) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    const result = await tenantQuery(req.user!.orgId,
      `SELECT event_type, spec, test, status, duration_ms, error_message, stats, created_at
       FROM live_events WHERE run_id = $1 ORDER BY id ASC LIMIT 500`,
      [runId]
    );

    const events = result.rows.map((row: any) => ({
      type: row.event_type,
      spec: row.spec,
      test: row.test,
      status: row.status,
      duration_ms: row.duration_ms,
      error: row.error_message,
      stats: row.stats,
      timestamp: new Date(row.created_at).getTime(),
    }));

    res.json(events);
  } catch (err) {
    console.error("GET /live/:runId/history error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /live/:runId/events — receive live test events from reporters.
 * Body: LiveTestEvent or LiveTestEvent[]
 */
router.post("/:runId/events", async (req, res) => {
  const runId = Number(req.params.runId);
  if (!runId) {
    res.status(400).json({ error: "Invalid run ID" });
    return;
  }

  const orgId = req.user!.orgId;

  // Verify the run belongs to the caller's org before emitting any SSE events.
  // Without this check an authenticated user from a different org could inject
  // events into another org's live stream (cross-org SSE stream poisoning).
  const owns = await tenantQuery(orgId, "SELECT 1 FROM runs WHERE id = $1", [runId]);
  if (!owns.rowCount) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const events: LiveTestEvent[] = Array.isArray(req.body) ? req.body : [req.body];

  // Lazy-register runs that didn't go through /live/start (external runIds
  // handed to reporters, direct event posts against an existing run, etc.)
  // so stale detection still catches them.
  if (!liveEvents.hasRun(runId)) liveEvents.registerRun(runId, orgId);

  // Treat every events POST — including empty-body heartbeats — as proof
  // the reporter is still alive. Without this, a long-running scenario that
  // produces no test events for >10 min trips the stale-run check and the
  // run is incorrectly flagged as aborted.
  liveEvents.touch(runId);

  const fullEvents: LiveTestEvent[] = events.map((event) => ({
    ...event,
    runId,
    timestamp: event.timestamp ?? Date.now(),
  }));

  // Send response immediately so the reporter isn't blocked.
  res.json({ ok: true, listeners: liveEvents.hasListeners(runId) });

  // Per-run serialization. Each POST's processing awaits the previous POST's
  // chain for the same run, so:
  //   1. test.started's INSERT is committed before a follow-up test.passed
  //      from the next POST runs its UPDATE (closes the duplicate-row race
  //      where the UPDATE matched zero pending rows and the fallback INSERT
  //      created a second terminal row alongside the still-uncommitted
  //      pending one).
  //   2. The SSE emit for run.finished cannot fire before the DB writes for
  //      preceding test.passed/failed events have committed. The frontend
  //      stops polling and refetches once on run.finished — without
  //      ordering, that refetch can land before the last test row was
  //      flipped, leaving a row visibly stuck in "pending" forever.
  // Different runs have independent chain entries, so cross-run traffic
  // still parallelises (this is what the live-parallel.spec.ts coverage
  // asserts). Within-run sequential processing matches the LiveClient's
  // own batch-then-await behaviour, so the perceived latency of a single
  // reporter is unchanged.
  enqueueOnRun(runId, async () => {
    for (const fullEvent of fullEvents) {
      // If the run was deleted while this chain entry was queued, every
      // subsequent DB write will FK-fail (runs.id is gone, ON DELETE
      // CASCADE already dropped specs/tests/live_events for it). The
      // forgetLiveRun() called from DELETE /runs/:id clears the runMeta
      // entry; this re-check stops us writing event after event of
      // FK-noise to stderr for a run that no longer exists.
      if (!liveEvents.hasRun(runId)) return;

      // 1) DB writes first so the persisted state is consistent before any
      //    SSE listener triggers a refetch.
      if (fullEvent.type === "spec.started") {
        await upsertLiveSpec(orgId, runId, fullEvent);
      } else if (fullEvent.type === "spec.finished") {
        await updateLiveSpecStats(orgId, runId, fullEvent);
      } else if (fullEvent.type === "test.started") {
        await upsertPendingTest(orgId, runId, fullEvent);
      } else if (
        fullEvent.type === "test.passed" ||
        fullEvent.type === "test.failed" ||
        fullEvent.type === "test.skipped"
      ) {
        await insertLiveTestResult(orgId, runId, fullEvent);
      }
      // 2) Persist the raw event log (await so insert order matches
      //    receive order — /live/:id/history relies on id ASC for
      //    chronological replay).
      await persistEventAwaited(orgId, runId, fullEvent);
      // 3) Emit to SSE last, now that DB state is consistent.
      liveEvents.emit(runId, fullEvent);
    }
  });
});

// Per-run promise chain so events for the same run process strictly in
// arrival order. Map entries are removed once their chain settles.
const runEventChain = new Map<number, Promise<void>>();

/**
 * Append `work` to the per-run processing chain. Concurrent calls for the
 * same run serialize; different runs run in parallel. Returns the promise
 * for the appended work so callers (like abort) can await its completion.
 */
function enqueueOnRun(runId: number, work: () => Promise<void>): Promise<void> {
  const previous = runEventChain.get(runId) ?? Promise.resolve();
  const thisChain = previous
    .then(work)
    .catch((err) => console.error("[live] chain error:", err));
  runEventChain.set(runId, thisChain);
  // Free the map entry once this chain settles, but only if no later
  // call has chained off it (otherwise we'd orphan the chain and the
  // next caller would skip the wait).
  thisChain.finally(() => {
    if (runEventChain.get(runId) === thisChain) runEventChain.delete(runId);
  });
  return thisChain;
}

/**
 * Forget every in-memory trace of a run — bus emitters, stale-detection
 * registry, and any pending chain entry. Called from DELETE /runs/:id
 * after the row is gone, so that:
 *   1. The stale-run timer doesn't fire abortRun for a deleted run
 *      (which would FK-fail on persistEvent's INSERT into live_events).
 *   2. In-flight events from a still-running reporter no longer try
 *      to UPSERT specs/tests against a deleted runs.id (FK fail) or
 *      a now-foreign org_id (RLS fail).
 *   3. /live/active stops listing the deleted run id.
 */
export function forgetLiveRun(runId: number): void {
  liveEvents.unregister(runId);
  runEventChain.delete(runId);
}

/**
 * Returns true when an error from a live-path INSERT/UPDATE is the
 * "run was deleted between when this work was queued and when it
 * actually ran" race — Postgres FK violation (SQLSTATE 23503) on a
 * runs.id reference, OR an RLS rejection on a tenancy policy that's
 * empty because the parent run is gone.
 *
 * We swallow these silently because they're expected in the narrow
 * window between DELETE /runs/:id (which calls forgetLiveRun and
 * starts the CASCADE) and the in-flight chain step finishing its
 * already-issued SQL roundtrips. Log noise from this case used to
 * spam stderr for every deleted run; real DB errors (unique violations,
 * connection drops, syntax errors) still surface.
 */
function isPostDeleteRace(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string };
  if (e.code === "23503") return true; // foreign_key_violation — runs.id gone
  // RLS rejection on a child table whose parent run was deleted —
  // pg surfaces this as 42501 with a "row-level security policy" marker.
  if (e.code === "42501" && /row-level security/i.test(e.message ?? "")) return true;
  return false;
}

/** Persist a live event to the database (fire-and-forget). */
function persistEvent(orgId: number, runId: number, event: LiveTestEvent): void {
  tenantQuery(orgId,
    `INSERT INTO live_events (run_id, org_id, event_type, spec, test, status, duration_ms, error_message, stats)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [runId, orgId, event.type, event.spec ?? null, event.test ?? null, event.status ?? null,
     event.duration_ms ?? null, event.error ?? null, event.stats ? JSON.stringify(event.stats) : null]
  ).catch((err) => {
    if (isPostDeleteRace(err)) return;
    console.error("Failed to persist live event:", err.message);
  });
}

/**
 * Awaited variant — the per-run event chain calls this so that
 * /live/:id/history rows land in receive order (ordered by id ASC).
 * Errors are swallowed so a failed insert doesn't break the chain for
 * subsequent events.
 */
async function persistEventAwaited(orgId: number, runId: number, event: LiveTestEvent): Promise<void> {
  try {
    await tenantQuery(orgId,
      `INSERT INTO live_events (run_id, org_id, event_type, spec, test, status, duration_ms, error_message, stats)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [runId, orgId, event.type, event.spec ?? null, event.test ?? null, event.status ?? null,
       event.duration_ms ?? null, event.error ?? null, event.stats ? JSON.stringify(event.stats) : null]
    );
  } catch (err: unknown) {
    if (isPostDeleteRace(err)) return;
    console.error("Failed to persist live event:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Find the spec id for the given run + file_path, creating a row if needed.
 * Returns the spec id, or null on error.
 */
async function findOrCreateSpec(orgId: number, runId: number, specPath: string): Promise<number | null> {
  // Atomic find-or-create backed by the unique index on (run_id, file_path)
  // added in migration 030. RETURNING id on ON CONFLICT DO UPDATE gives us
  // the existing row's id without a second SELECT, closing the race where
  // two concurrent events would each create a separate spec.
  const upserted = await tenantQuery(orgId,
    `INSERT INTO specs (run_id, file_path, title, total, passed, failed, skipped, duration_ms)
     VALUES ($1, $2, $3, 0, 0, 0, 0, 0)
     ON CONFLICT (run_id, file_path) DO UPDATE SET file_path = EXCLUDED.file_path
     RETURNING id`,
    [runId, specPath, specPath.split("/").pop() ?? specPath]
  );
  return upserted.rows[0]?.id as number ?? null;
}

/**
 * Ensure a spec row exists when a spec.started event arrives so it shows up
 * on the run detail page even before any test events are received.
 * Called sequentially — safe from race conditions within a single request.
 */
async function upsertLiveSpec(orgId: number, runId: number, event: LiveTestEvent): Promise<void> {
  if (!event.spec) return;
  try {
    await findOrCreateSpec(orgId, runId, event.spec);
  } catch (err: any) {
    console.error("Failed to upsert live spec:", err.message);
  }
}

/**
 * Update a spec's aggregate stats when a spec.finished event arrives.
 *
 * When per-test rows exist for the spec we treat the tests table as the
 * source of truth — this is the case for reporters that stream test.passed
 * / test.failed / test.skipped events (Cypress, Playwright, WDIO). The
 * reporter's `event.stats` payload can undercount: e.g. the Cypress mocha
 * reporter emits `it.skip()` / `xit` tests as `test.skipped` events but
 * Cypress's own `results.stats.skipped` only counts tests skipped due to a
 * sibling failure, leaving `pending` tests out of the spec.finished payload.
 *
 * For reporters that only send spec-level summaries (Cucumber, etc.) we
 * fall back to writing the payload as-is so the dashboard still gets
 * meaningful numbers.
 */
async function updateLiveSpecStats(orgId: number, runId: number, event: LiveTestEvent): Promise<void> {
  if (!event.spec || !event.stats) return;
  try {
    const specRow = await tenantQuery(orgId,
      `SELECT id FROM specs WHERE run_id = $1 AND file_path = $2`,
      [runId, event.spec]
    );
    const specId = specRow.rows[0]?.id as number | undefined;

    if (specId !== undefined) {
      const testCount = await tenantQuery(orgId,
        `SELECT COUNT(*)::int AS n FROM tests WHERE spec_id = $1`,
        [specId]
      );
      if ((testCount.rows[0]?.n ?? 0) > 0) {
        await recomputeSpecAndRunStats(orgId, runId, specId);
        return;
      }
    }

    await tenantQuery(orgId,
      `UPDATE specs SET
        total   = $3,
        passed  = $4,
        failed  = $5,
        skipped = $6
      WHERE run_id = $1 AND file_path = $2`,
      [runId, event.spec, event.stats.total, event.stats.passed, event.stats.failed, event.stats.skipped]
    );

    await tenantQuery(orgId,
      `UPDATE runs SET
        total      = (SELECT COALESCE(SUM(total),      0) FROM specs WHERE run_id = $1),
        passed     = (SELECT COALESCE(SUM(passed),     0) FROM specs WHERE run_id = $1),
        failed     = (SELECT COALESCE(SUM(failed),     0) FROM specs WHERE run_id = $1),
        skipped    = (SELECT COALESCE(SUM(skipped),    0) FROM specs WHERE run_id = $1),
        duration_ms = (SELECT COALESCE(SUM(duration_ms), 0) FROM specs WHERE run_id = $1)
      WHERE id = $1`,
      [runId]
    );
  } catch (err: any) {
    console.error("Failed to update live spec stats:", err.message);
  }
}

/**
 * Insert a real spec + test row into the database for a live test event,
 * so test results appear on the run detail page in real-time.
 * Called sequentially — safe from race conditions within a single request.
 */
/**
 * Insert a placeholder test row when a test.started event arrives, so the UI
 * can show the test as pending while it's still running.
 */
async function upsertPendingTest(orgId: number, runId: number, event: LiveTestEvent): Promise<void> {
  if (!event.test) return;
  const specPath = event.spec ?? "unknown";
  try {
    const specId = await findOrCreateSpec(orgId, runId, specPath);
    if (specId === null) return;
    // INSERT a pending row only if no row at all exists for (spec_id,
    // full_title). Two layers of guards:
    //   - INSERT … SELECT … WHERE NOT EXISTS skips when a terminal
    //     row is already present (handles a stale or out-of-order
    //     test.started landing AFTER its test.passed/failed/skipped —
    //     without the WHERE NOT EXISTS we'd add a zombie pending row
    //     alongside the existing terminal one).
    //   - ON CONFLICT … DO NOTHING on the partial unique index handles
    //     the inverse race where two concurrent test.started events
    //     race past the WHERE NOT EXISTS check.
    const inserted = await tenantQuery(orgId,
      `INSERT INTO tests (spec_id, title, full_title, status, duration_ms, error_message, screenshot_paths)
       SELECT $1, $2, $2, 'pending', 0, NULL, '{}'
       WHERE NOT EXISTS (
         SELECT 1 FROM tests WHERE spec_id = $1 AND full_title = $2
       )
       ON CONFLICT (spec_id, full_title) WHERE status = 'pending' DO NOTHING
       RETURNING id`,
      [specId, event.test]
    );
    if (inserted.rowCount && inserted.rowCount > 0) {
      await recomputeSpecAndRunStats(orgId, runId, specId);
    }
  } catch (err: any) {
    if (isPostDeleteRace(err)) return;
    console.error("Failed to upsert pending test:", err.message);
  }
}

async function insertLiveTestResult(orgId: number, runId: number, event: LiveTestEvent): Promise<void> {
  if (!event.test) return;

  const status = event.type === "test.passed" ? "passed"
    : event.type === "test.failed" ? "failed"
    : event.type === "test.skipped" ? "skipped"
    : null;
  if (!status) return;

  const specPath = event.spec ?? "unknown";

  try {
    const specId = await findOrCreateSpec(orgId, runId, specPath);
    if (specId === null) return;

    // Upsert test row — update the pending row inserted on test.started if present.
    const updated = await tenantQuery(orgId,
      `UPDATE tests SET status = $3, duration_ms = $4, error_message = $5
       WHERE spec_id = $1 AND full_title = $2 AND status = 'pending'`,
      [specId, event.test, status, event.duration_ms ?? 0, event.error ?? null]
    );
    if (!updated.rowCount) {
      await tenantQuery(orgId,
        `INSERT INTO tests (spec_id, title, full_title, status, duration_ms, error_message, screenshot_paths)
         VALUES ($1, $2, $3, $4, $5, $6, '{}')`,
        [specId, event.test, event.test, status, event.duration_ms ?? 0, event.error ?? null]
      );
    }

    await recomputeSpecAndRunStats(orgId, runId, specId);
  } catch (err: any) {
    if (isPostDeleteRace(err)) return;
    console.error("Failed to insert live test result:", err.message);
  }
}

async function recomputeSpecAndRunStats(orgId: number, runId: number, specId: number): Promise<void> {
  await tenantQuery(orgId,
    `UPDATE specs SET
      total = (SELECT COUNT(*) FROM tests WHERE spec_id = $1),
      passed = (SELECT COUNT(*) FROM tests WHERE spec_id = $1 AND status = 'passed'),
      failed = (SELECT COUNT(*) FROM tests WHERE spec_id = $1 AND status = 'failed'),
      skipped = (SELECT COUNT(*) FROM tests WHERE spec_id = $1 AND status IN ('skipped', 'pending')),
      duration_ms = (SELECT COALESCE(SUM(duration_ms), 0) FROM tests WHERE spec_id = $1)
    WHERE id = $1`,
    [specId]
  );
  await tenantQuery(orgId,
    `UPDATE runs SET
      total = (SELECT COALESCE(SUM(total), 0) FROM specs WHERE run_id = $1),
      passed = (SELECT COALESCE(SUM(passed), 0) FROM specs WHERE run_id = $1),
      failed = (SELECT COALESCE(SUM(failed), 0) FROM specs WHERE run_id = $1),
      skipped = (SELECT COALESCE(SUM(skipped), 0) FROM specs WHERE run_id = $1),
      duration_ms = (SELECT COALESCE(SUM(duration_ms), 0) FROM specs WHERE run_id = $1)
    WHERE id = $1`,
    [runId]
  );
}

/**
 * POST /live/:runId/snapshot — stream a single DOM snapshot bundle mid-run.
 * Body (multipart): file field "snapshot" (.json.gz), text fields "spec" and "testTitle".
 * Stores at runs/{runId}/snapshots/{spec}--{title}.json.gz — same key pattern the
 * end-of-run batch uploader uses, so the existing title-match association still works.
 */
router.post("/:runId/snapshot", snapshotUpload.single("snapshot"), async (req, res) => {
  try {
    const runId = Number(req.params.runId);
    if (!runId) {
      res.status(400).json({ error: "Invalid run ID" });
      return;
    }

    const file = req.file;
    const spec = typeof req.body?.spec === "string" ? req.body.spec : "";
    const testTitle = typeof req.body?.testTitle === "string" ? req.body.testTitle : "";
    if (!file || !spec || !testTitle) {
      res.status(400).json({ error: "snapshot file, spec, and testTitle are required" });
      return;
    }

    const orgId = req.user!.orgId;
    const owns = await tenantQuery(orgId, `SELECT 1 FROM runs WHERE id = $1`, [runId]);
    if (owns.rowCount === 0) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    const safeTitle = testTitle.replace(/[^a-zA-Z0-9_\- ]/g, "").replace(/\s+/g, "-").slice(0, 100);
    const safeSpec = spec.replace(/[^a-zA-Z0-9_\-./]/g, "").replace(/\//g, "__");
    const fileName = `${safeSpec}--${safeTitle}.json.gz`;
    const key = `runs/${runId}/snapshots/${fileName}`;

    await getStorage().put(file.path, key);

    // If a test row already exists for this run + spec + title, link the
    // snapshot. Match full_title exactly OR as a trailing substring (older
    // clients send leaf title only). Escape LIKE special chars in the
    // parameter so a title containing '%' or '_' doesn't match unintended
    // rows. Filter by specs.file_path so a same-titled test in a different
    // spec of the same run doesn't also pick up this snapshot.
    const escapedTitle = testTitle.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    await tenantQuery(orgId,
      `UPDATE tests SET snapshot_path = $3
       FROM specs
       WHERE specs.id = tests.spec_id
         AND specs.run_id = $1
         AND specs.file_path = $5
         AND (tests.full_title = $2 OR tests.full_title LIKE '%' || $4 ESCAPE '\\')`,
      [runId, testTitle, key, escapedTitle, spec]
    );

    res.status(200).json({ key });
  } catch (err) {
    console.error("POST /live/:runId/snapshot error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /live/:runId/screenshot — stream a single screenshot mid-run.
 * Body (multipart): file field "screenshot" (.png), text fields "spec" and "testTitle".
 * Stores at runs/{runId}/screenshots/{filename} and appends the relative path to
 * the matching test's screenshot_paths array. The path is preserved across the
 * end-of-run upload's tests delete+reinsert (see routes/uploads.ts), so the
 * association survives the final batch upload.
 */
router.post("/:runId/screenshot", screenshotUpload.single("screenshot"), async (req, res) => {
  try {
    const runId = Number(req.params.runId);
    if (!runId) {
      res.status(400).json({ error: "Invalid run ID" });
      return;
    }

    const file = req.file;
    const spec = typeof req.body?.spec === "string" ? req.body.spec : "";
    const testTitle = typeof req.body?.testTitle === "string" ? req.body.testTitle : "";
    if (!file || !spec || !testTitle) {
      res.status(400).json({ error: "screenshot file, spec, and testTitle are required" });
      return;
    }

    const orgId = req.user!.orgId;
    const owns = await tenantQuery(orgId, `SELECT 1 FROM runs WHERE id = $1`, [runId]);
    if (owns.rowCount === 0) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    const originalName = typeof file.originalname === "string" && file.originalname
      ? file.originalname
      : `${Date.now()}.png`;
    const safeName = originalName.replace(/[^a-zA-Z0-9_\-. ]/g, "_").slice(0, 200);
    const key = `runs/${runId}/screenshots/${safeName}`;

    await getStorage().put(file.path, key);

    // Match the test row by full_title (exact or trailing substring — older
    // clients may send the leaf title only) AND by the spec the upload was
    // tagged for. Without the spec.file_path filter, two different specs in
    // the same run with the same test title both pick up the screenshot —
    // earlier coverage missed this because it depended on row-creation
    // ordering. LIKE special chars in the title are escaped so a '%' or
    // '_' in the test name doesn't widen the match.
    const escapedTitle = testTitle.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const updated = await tenantQuery(orgId,
      `UPDATE tests SET screenshot_paths = array_append(COALESCE(screenshot_paths, ARRAY[]::text[]), $3)
       FROM specs
       WHERE specs.id = tests.spec_id
         AND specs.run_id = $1
         AND specs.file_path = $5
         AND (tests.full_title = $2 OR tests.full_title LIKE '%' || $4 ESCAPE '\\')
         AND NOT ($3 = ANY(COALESCE(tests.screenshot_paths, ARRAY[]::text[])))`,
      [runId, testTitle, key, escapedTitle, spec]
    );

    // Race guard: POST /events returns 200 before its DB writes complete
    // (events are processed sequentially in a post-response IIFE). A reporter
    // that sends `test.started` then immediately uploads a screenshot can
    // arrive here before the test row has been INSERTed. Without this fallback
    // the screenshot file is stored to S3/disk but orphaned — it never
    // attaches to any test, and the user never sees it. Upsert a pending
    // row keyed on (spec, full_title) so the screenshot lands somewhere.
    if (!updated.rowCount) {
      const specId = await findOrCreateSpec(orgId, runId, spec);
      if (specId !== null) {
        await tenantQuery(orgId,
          `INSERT INTO tests (spec_id, title, full_title, status, duration_ms, error_message, screenshot_paths)
           VALUES ($1, $2, $2, 'pending', 0, NULL, ARRAY[$3]::text[])
           ON CONFLICT (spec_id, full_title) WHERE status = 'pending' DO UPDATE
             SET screenshot_paths = array_append(
               COALESCE(tests.screenshot_paths, ARRAY[]::text[]), $3
             )
             WHERE NOT ($3 = ANY(COALESCE(tests.screenshot_paths, ARRAY[]::text[])))`,
          [specId, testTitle, key]
        );
        await recomputeSpecAndRunStats(orgId, runId, specId);
      }
    }

    res.status(200).json({ key });
  } catch (err) {
    console.error("POST /live/:runId/screenshot error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /live/:runId/abort — mark a live run as aborted (e.g. from a SIGINT/SIGTERM handler).
 * Reporters can call this on graceful shutdown so the UI updates immediately.
 */
router.post("/:runId/abort", async (req, res) => {
  const runId = Number(req.params.runId);
  if (!runId) {
    res.status(400).json({ error: "Invalid run ID" });
    return;
  }

  const orgId = req.user!.orgId;

  // Verify the run belongs to the caller's org before emitting the aborted event.
  // Without this check an authenticated user from a different org could abort
  // another org's live run and poison their SSE stream.
  const owns = await tenantQuery(orgId, "SELECT 1 FROM runs WHERE id = $1", [runId]);
  if (!owns.rowCount) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const reason = typeof req.body?.reason === "string" && req.body.reason.trim()
    ? req.body.reason.trim().slice(0, 500)
    : "Run aborted by reporter (process received shutdown signal).";
  await abortRun(runId, orgId, reason);
  res.json({ ok: true });
});

/**
 * GET /live/:runId/stream — SSE endpoint for live test events.
 * Browsers/frontends connect here to receive real-time updates.
 */
router.get("/:runId/stream", async (req, res) => {
  const runId = Number(req.params.runId);
  if (!runId) {
    res.status(400).json({ error: "Invalid run ID" });
    return;
  }

  // Verify the run belongs to the caller's org BEFORE writing the SSE
  // headers.  The emitter is keyed by runId only — without this check
  // any authenticated user can subscribe to any org's live stream
  // (test titles, error messages, screenshots-via-events) by knowing
  // the run id.  Cross-tenant data leak via the SSE channel.
  const owns = await tenantQuery(req.user!.orgId, "SELECT 1 FROM runs WHERE id = $1", [runId]);
  if (!owns.rowCount) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });

  // Send initial ping
  res.write("data: {\"type\":\"connected\"}\n\n");

  const emitter = liveEvents.getEmitter(runId);

  const handler = (event: LiveTestEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  emitter.on("event", handler);

  // Keep-alive every 15 seconds
  const keepAlive = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);

  req.on("close", () => {
    emitter.off("event", handler);
    clearInterval(keepAlive);
  });
});

/** Emit and persist a run.aborted event, removing the run from the active set. */
async function abortRun(runId: number, orgId: number, reason: string): Promise<void> {
  // Run on the per-run chain so the abort observes any in-flight /events
  // POSTs that haven't yet inserted their pending rows. Without this, an
  // abort racing a not-yet-committed test.started would UPDATE zero rows;
  // the pending INSERT then lands afterwards and is never transitioned,
  // leaving a row stuck in 'pending' even though the run is aborted.
  await enqueueOnRun(runId, async () => {
    // Bail if forgetLiveRun() has already wiped this run from the bus —
    // the stale-detection timer can capture a runId in its sweep,
    // queue abortRun onto the chain, and then a DELETE /runs/:id can
    // race in BEFORE this chained work executes. Without this guard,
    // transitionPendingTestsAfterAbort + persistEventAwaited both
    // FK-fail because runs.id is gone, and stderr fills with
    // `live_events_run_id_fkey` on every deleted run.
    if (!liveEvents.hasRun(runId)) return;

    // Transition pending → skipped FIRST, so the DB is consistent before any
    // SSE listener refetches /runs/:id. The frontend's run-detail page calls
    // fetchRun() the moment it receives a `run.aborted` event; if we emit
    // before the UPDATE lands, the page sees stale `pending` rows and (since
    // it also stops the 3s poll on abort) never refreshes them again. The
    // user-visible symptom is a test row stuck in the "in progress" dot
    // forever after a kill.
    await transitionPendingTestsAfterAbort(orgId, runId, reason);

    const event: LiveTestEvent = {
      type: "run.aborted",
      runId,
      timestamp: Date.now(),
      error: reason,
    };
    liveEvents.emit(runId, event);
    await persistEventAwaited(orgId, runId, event);
  });
}

async function transitionPendingTestsAfterAbort(
  orgId: number,
  runId: number,
  reason: string,
): Promise<void> {
  try {
    const result = await tenantQuery(
      orgId,
      `UPDATE tests SET status = 'skipped', error_message = $2
       FROM specs
       WHERE specs.id = tests.spec_id
         AND specs.run_id = $1
         AND tests.status = 'pending'
       RETURNING tests.spec_id`,
      [runId, `Run aborted before this test completed — ${reason}`],
    );
    if (!result.rowCount) return;
    // Recompute stats for each affected spec, then for the run.
    const specIds = Array.from(new Set(result.rows.map((r) => r.spec_id as number)));
    for (const specId of specIds) {
      await recomputeSpecAndRunStats(orgId, runId, specId);
    }
  } catch (err: unknown) {
    if (isPostDeleteRace(err)) return;
    console.error(
      "Failed to transition pending tests after abort:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// Mark runs as aborted after N ms of no events — handles terminal/process kills.
// Configurable via FLAKEY_LIVE_TIMEOUT_MS (default 10 min). Check cadence scales
// with the timeout so tests can use a short window without busy-looping.
const STALE_INACTIVITY_MS = Math.max(
  1000,
  Number(process.env.FLAKEY_LIVE_TIMEOUT_MS) || 10 * 60 * 1000
);
const STALE_CHECK_INTERVAL_MS = Math.max(500, Math.min(30_000, Math.floor(STALE_INACTIVITY_MS / 4)));

// unref() so the interval doesn't keep the event loop alive on its own — the
// Express server is the thing that keeps the process running; test harnesses
// that spawn+kill the server shouldn't hang waiting for this timer.
const staleCheckTimer = setInterval(() => {
  const stale = liveEvents.getStaleRuns(STALE_INACTIVITY_MS);
  for (const { runId, orgId } of stale) {
    console.log(`[live] Run ${runId} is stale — marking as aborted`);
    void abortRun(runId, orgId, "Run stopped unexpectedly — the test process may have been killed or the terminal was closed.");
  }
}, STALE_CHECK_INTERVAL_MS);
staleCheckTimer.unref();

export default router;
