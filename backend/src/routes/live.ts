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
router.get("/active", (_req, res) => {
  res.json({ runs: liveEvents.getActiveRunIds() });
});

/**
 * POST /live/start — create a placeholder run for live tracking, returns the run ID.
 * Body: { suite, branch?, commitSha?, ciRunId? }
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

    const result = await tenantQuery(orgId,
      `INSERT INTO runs (suite_name, branch, commit_sha, ci_run_id, reporter, started_at, finished_at, total, passed, failed, skipped, pending, duration_ms, org_id, environment)
       VALUES ($1, $2, $3, $4, 'live', NOW(), NOW(), 0, 0, 0, 0, 0, 0, $5, $6)
       RETURNING id`,
      [suite, branch ?? "", commitSha ?? "", effectiveCiRunId, orgId, env]
    );

    const runId = result.rows[0].id;
    liveEvents.registerRun(runId, orgId);
    liveEvents.emit(runId, { type: "run.started", runId, timestamp: Date.now() });

    // Persist the start event
    persistEvent(orgId, runId, { type: "run.started", runId, timestamp: Date.now() });

    res.status(201).json({ id: runId, ci_run_id: effectiveCiRunId });
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

  const fullEvents: LiveTestEvent[] = [];
  for (const event of events) {
    const fullEvent = { ...event, runId, timestamp: event.timestamp ?? Date.now() };
    fullEvents.push(fullEvent);
    liveEvents.emit(runId, fullEvent);
    persistEvent(orgId, runId, fullEvent);
  }

  // Send response immediately so the reporter isn't blocked
  res.json({ ok: true, listeners: liveEvents.hasListeners(runId) });

  // Process DB writes sequentially after the response to avoid race conditions
  // when multiple test events for the same spec arrive in a single batch.
  // Wrapped in an async IIFE with a top-level .catch() so any unhandled error
  // does not propagate to Node's global unhandled-rejection handler.
  (async () => {
    for (const fullEvent of fullEvents) {
      if (fullEvent.type === "spec.started") {
        await upsertLiveSpec(orgId, runId, fullEvent);
      } else if (fullEvent.type === "spec.finished") {
        await updateLiveSpecStats(orgId, runId, fullEvent);
      } else if (fullEvent.type === "test.started") {
        await upsertPendingTest(orgId, runId, fullEvent);
      } else if (fullEvent.type === "test.passed" || fullEvent.type === "test.failed" || fullEvent.type === "test.skipped") {
        await insertLiveTestResult(orgId, runId, fullEvent);
      }
    }
  })().catch(err => console.error("[live] post-response DB error:", err));
});

/** Persist a live event to the database (fire-and-forget). */
function persistEvent(orgId: number, runId: number, event: LiveTestEvent): void {
  tenantQuery(orgId,
    `INSERT INTO live_events (run_id, org_id, event_type, spec, test, status, duration_ms, error_message, stats)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [runId, orgId, event.type, event.spec ?? null, event.test ?? null, event.status ?? null,
     event.duration_ms ?? null, event.error ?? null, event.stats ? JSON.stringify(event.stats) : null]
  ).catch((err) => {
    console.error("Failed to persist live event:", err.message);
  });
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
    // Atomic insert-or-skip backed by the partial unique index
    // `idx_tests_pending_unique` (migration 030). Two concurrent test.started
    // events with the same spec/title can both race past an app-level SELECT,
    // so we rely on the DB to enforce uniqueness and silently drop the dup.
    const inserted = await tenantQuery(orgId,
      `INSERT INTO tests (spec_id, title, full_title, status, duration_ms, error_message, screenshot_paths)
       VALUES ($1, $2, $2, 'pending', 0, NULL, '{}')
       ON CONFLICT (spec_id, full_title) WHERE status = 'pending' DO NOTHING
       RETURNING id`,
      [specId, event.test]
    );
    if (inserted.rowCount && inserted.rowCount > 0) {
      await recomputeSpecAndRunStats(orgId, runId, specId);
    }
  } catch (err: any) {
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

    // If a test row already exists for this run + title, link the snapshot.
    // Match full_title exactly OR as a trailing substring (older clients send
    // leaf title only). Escape LIKE special chars in the parameter so a title
    // containing '%' or '_' doesn't match unintended rows.
    const escapedTitle = testTitle.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    await tenantQuery(orgId,
      `UPDATE tests SET snapshot_path = $3
       FROM specs
       WHERE specs.id = tests.spec_id
         AND specs.run_id = $1
         AND (tests.full_title = $2 OR tests.full_title LIKE '%' || $4 ESCAPE '\\')`,
      [runId, testTitle, key, escapedTitle]
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
    // clients may send the leaf title only). LIKE special chars in the title
    // are escaped so a '%' or '_' in the test name doesn't widen the match.
    const escapedTitle = testTitle.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    await tenantQuery(orgId,
      `UPDATE tests SET screenshot_paths = array_append(COALESCE(screenshot_paths, ARRAY[]::text[]), $3)
       FROM specs
       WHERE specs.id = tests.spec_id
         AND specs.run_id = $1
         AND (tests.full_title = $2 OR tests.full_title LIKE '%' || $4 ESCAPE '\\')
         AND NOT ($3 = ANY(COALESCE(tests.screenshot_paths, ARRAY[]::text[])))`,
      [runId, testTitle, key, escapedTitle]
    );

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
  abortRun(runId, orgId, reason);
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
function abortRun(runId: number, orgId: number, reason: string): void {
  const event: LiveTestEvent = {
    type: "run.aborted",
    runId,
    timestamp: Date.now(),
    error: reason,
  };
  liveEvents.emit(runId, event);
  persistEvent(orgId, runId, event);
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
    abortRun(runId, orgId, "Run stopped unexpectedly — the test process may have been killed or the terminal was closed.");
  }
}, STALE_CHECK_INTERVAL_MS);
staleCheckTimer.unref();

export default router;
