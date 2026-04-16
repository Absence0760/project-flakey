import { Router } from "express";
import crypto from "crypto";
import { tenantQuery } from "../db.js";
import { liveEvents, type LiveTestEvent } from "../live-events.js";

const router = Router();

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
    const { suite, branch, commitSha, ciRunId } = req.body;
    if (!suite) {
      res.status(400).json({ error: "suite is required" });
      return;
    }

    const orgId = req.user!.orgId;
    // Generate a ci_run_id so the main reporter's upload merges into this run
    const effectiveCiRunId = ciRunId || `live-${crypto.randomBytes(8).toString("hex")}`;

    const result = await tenantQuery(orgId,
      `INSERT INTO runs (suite_name, branch, commit_sha, ci_run_id, reporter, started_at, finished_at, total, passed, failed, skipped, pending, duration_ms, org_id)
       VALUES ($1, $2, $3, $4, 'live', NOW(), NOW(), 0, 0, 0, 0, 0, 0, $5)
       RETURNING id`,
      [suite, branch ?? "", commitSha ?? "", effectiveCiRunId, orgId]
    );

    const runId = result.rows[0].id;
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
  const events: LiveTestEvent[] = Array.isArray(req.body) ? req.body : [req.body];

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
  for (const fullEvent of fullEvents) {
    if (fullEvent.type === "spec.started") {
      await upsertLiveSpec(orgId, runId, fullEvent);
    } else if (fullEvent.type === "spec.finished") {
      await updateLiveSpecStats(orgId, runId, fullEvent);
    } else if (fullEvent.type === "test.passed" || fullEvent.type === "test.failed" || fullEvent.type === "test.skipped") {
      await insertLiveTestResult(orgId, runId, fullEvent);
    }
  }
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
  const existing = await tenantQuery(orgId,
    "SELECT id FROM specs WHERE run_id = $1 AND file_path = $2 LIMIT 1",
    [runId, specPath]
  );
  if (existing.rows.length > 0) return existing.rows[0].id as number;

  const inserted = await tenantQuery(orgId,
    `INSERT INTO specs (run_id, file_path, title, total, passed, failed, skipped, duration_ms)
     VALUES ($1, $2, $3, 0, 0, 0, 0, 0) RETURNING id`,
    [runId, specPath, specPath.split("/").pop() ?? specPath]
  );
  return inserted.rows[0]?.id as number ?? null;
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
 * Uses the stats payload sent by the reporter so the numbers are authoritative
 * even when individual test events were not sent (e.g. Cucumber reporters).
 */
async function updateLiveSpecStats(orgId: number, runId: number, event: LiveTestEvent): Promise<void> {
  if (!event.spec || !event.stats) return;
  try {
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

    // Insert test
    await tenantQuery(orgId,
      `INSERT INTO tests (spec_id, title, full_title, status, duration_ms, error_message, screenshot_paths)
       VALUES ($1, $2, $3, $4, $5, $6, '{}')`,
      [specId, event.test, event.test, status, event.duration_ms ?? 0, event.error ?? null]
    );

    // Update spec stats
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

    // Update run stats
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
  } catch (err: any) {
    console.error("Failed to insert live test result:", err.message);
  }
}

/**
 * GET /live/:runId/stream — SSE endpoint for live test events.
 * Browsers/frontends connect here to receive real-time updates.
 */
router.get("/:runId/stream", (req, res) => {
  const runId = Number(req.params.runId);
  if (!runId) {
    res.status(400).json({ error: "Invalid run ID" });
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

export default router;
