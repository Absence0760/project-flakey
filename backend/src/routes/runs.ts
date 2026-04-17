import { Router } from "express";
import { tenantQuery, tenantTransaction } from "../db.js";
import { normalize } from "../normalizers/index.js";
import { logAudit } from "../audit.js";
import { dispatchRunFailed } from "../webhooks.js";
import { postPRComment } from "../git-providers/index.js";
import { findOrCreateRun, recalculateRunStats } from "../run-merge.js";
import type { NormalizedRun } from "../types.js";

const router = Router();

// POST /runs — receive a normalized or raw report
router.post("/", async (req, res) => {
  try {
    const body = req.body as {
      reporter?: string;
      meta?: NormalizedRun["meta"];
      raw?: unknown;
      stats?: NormalizedRun["stats"];
      specs?: NormalizedRun["specs"];
    };

    let run: NormalizedRun;

    if (body.raw && body.meta?.reporter) {
      run = normalize(body.meta.reporter, body.raw, body.meta);
    } else if (body.meta && body.stats && body.specs) {
      run = { meta: body.meta, stats: body.stats, specs: body.specs };
    } else {
      res.status(400).json({ error: "Provide either {raw, meta} or {meta, stats, specs}" });
      return;
    }

    const orgId = req.user!.orgId;
    let runId: number;
    let merged = false;

    await tenantTransaction(orgId, async (client) => {
      const result = await findOrCreateRun(client, orgId, run);
      runId = result.runId;
      merged = result.merged;

      for (const spec of run.specs) {
        // Upsert against uniq_specs_run_file (migration 030). The live path
        // may have already created this spec row during spec.started; this
        // upload is the authoritative stats snapshot, so overwrite.
        const specResult = await client.query(
          `INSERT INTO specs (run_id, file_path, title, total, passed, failed, skipped, duration_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (run_id, file_path) DO UPDATE SET
             title       = EXCLUDED.title,
             total       = EXCLUDED.total,
             passed      = EXCLUDED.passed,
             failed      = EXCLUDED.failed,
             skipped     = EXCLUDED.skipped,
             duration_ms = EXCLUDED.duration_ms
           RETURNING id`,
          [runId, spec.file_path, spec.title, spec.stats.total, spec.stats.passed, spec.stats.failed, spec.stats.skipped, spec.stats.duration_ms]
        );
        const specId = specResult.rows[0].id;

        // Replace any live-path test rows for this spec — the upload carries
        // the authoritative per-test list, so prior pending/partial rows
        // would otherwise accumulate as duplicates. Snapshot the live-path's
        // snapshot_path linkages (written by /live/:runId/snapshot mid-run)
        // so we can re-apply them to the fresh rows by matching full_title.
        const preserved = await client.query(
          `SELECT full_title, snapshot_path FROM tests WHERE spec_id = $1 AND snapshot_path IS NOT NULL`,
          [specId]
        );
        const snapshotByTitle = new Map<string, string>();
        for (const row of preserved.rows) snapshotByTitle.set(row.full_title, row.snapshot_path);

        await client.query(`DELETE FROM tests WHERE spec_id = $1`, [specId]);

        for (const test of spec.tests) {
          await client.query(
            `INSERT INTO tests (spec_id, title, full_title, status, duration_ms, error_message, error_stack, screenshot_paths, video_path, test_code, command_log, metadata, snapshot_path)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [specId, test.title, test.full_title, test.status, test.duration_ms,
             test.error?.message ?? null, test.error?.stack ?? null,
             test.screenshot_paths, test.video_path ?? null,
             test.test_code ?? null, test.command_log ? JSON.stringify(test.command_log) : null,
             test.metadata ? JSON.stringify(test.metadata) : null,
             snapshotByTitle.get(test.full_title) ?? null]
          );
        }
      }

      if (merged) {
        await recalculateRunStats(client, runId);
      }
    });

    logAudit(req.user!.orgId, req.user!.id, "run.upload", "run", String(runId!), { suite: run.meta.suite_name, total: run.stats.total, failed: run.stats.failed, merged });

    // Only dispatch webhooks and PR comments after final merge
    // (they'll update in place if called multiple times for the same run)
    dispatchRunFailed(req.user!.orgId, runId!, run);
    postPRComment(req.user!.orgId, runId!, run);

    res.status(merged ? 200 : 201).json({ id: runId!, merged });
  } catch (err) {
    console.error("POST /runs error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /runs
router.get("/", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT r.*,
        (SELECT count(*)::int FROM specs s WHERE s.run_id = r.id) AS spec_count,
        (SELECT array_agg(sub.file_path) FROM (
           SELECT s.file_path FROM specs s WHERE s.run_id = r.id ORDER BY s.id LIMIT 5
         ) sub) AS spec_files,
        EXISTS (
          SELECT 1 FROM live_events le
          WHERE le.run_id = r.id AND le.event_type = 'run.aborted'
        ) AS aborted,
        COALESCE((
          SELECT count(*)::int
          FROM tests t
          JOIN specs s ON s.id = t.spec_id AND s.run_id = r.id
          WHERE t.status = 'failed'
            AND t.full_title NOT IN (
              SELECT t2.full_title FROM tests t2
              JOIN specs s2 ON s2.id = t2.spec_id
              WHERE s2.run_id = (
                SELECT r2.id FROM runs r2
                WHERE r2.suite_name = r.suite_name AND r2.org_id = r.org_id AND r2.id < r.id
                ORDER BY r2.id DESC LIMIT 1
              ) AND t2.status = 'failed'
            )
        ), 0) AS new_failures
       FROM runs r ORDER BY r.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const countResult = await tenantQuery(
      req.user!.orgId,
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE failed = 0)::int AS passed,
              count(*) FILTER (WHERE failed > 0)::int AS failed
       FROM runs`
    );
    const summary = countResult.rows[0] ?? { total: 0, passed: 0, failed: 0 };
    res.json({ runs: result.rows, summary, hasMore: offset + result.rows.length < summary.total });
  } catch (err) {
    console.error("GET /runs error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /runs/check — check failure count for a CI run (auto-cancellation)
// Query: ?ci_run_id=X&suite=name&threshold=3
// Returns: { should_cancel, failed, threshold, run_id }
router.get("/check", async (req, res) => {
  try {
    const ciRunId = req.query.ci_run_id as string | undefined;
    const suite = req.query.suite as string | undefined;
    const threshold = Number(req.query.threshold) || 3;

    if (!ciRunId) {
      res.status(400).json({ error: "ci_run_id is required" });
      return;
    }

    const orgId = req.user!.orgId;
    let query = "SELECT id, failed, total, passed, skipped FROM runs WHERE ci_run_id = $1";
    const params: unknown[] = [ciRunId];

    if (suite) {
      query += " AND suite_name = $2";
      params.push(suite);
    }

    query += " ORDER BY created_at DESC LIMIT 1";

    const result = await tenantQuery(orgId, query, params);

    if (result.rows.length === 0) {
      res.json({ should_cancel: false, failed: 0, threshold, run_id: null });
      return;
    }

    const run = result.rows[0];
    res.json({
      should_cancel: run.failed >= threshold,
      failed: run.failed,
      total: run.total,
      passed: run.passed,
      threshold,
      run_id: run.id,
    });
  } catch (err) {
    console.error("GET /runs/check error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /runs/:id
router.get("/:id", async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const runId = req.params.id;

    const runResult = await tenantQuery(orgId,
      `SELECT r.*, so.rerun_command_template,
        EXISTS (
          SELECT 1 FROM live_events le
          WHERE le.run_id = r.id AND le.event_type = 'run.aborted'
        ) AS aborted,
        (
          SELECT le.error_message FROM live_events le
          WHERE le.run_id = r.id AND le.event_type = 'run.aborted'
          ORDER BY le.id DESC LIMIT 1
        ) AS aborted_reason
       FROM runs r
       LEFT JOIN suite_overrides so ON so.suite_name = r.suite_name AND so.org_id = r.org_id
       WHERE r.id = $1`,
      [runId]
    );
    if (runResult.rows.length === 0) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    // Adjacent runs for prev/next navigation
    const adjResult = await tenantQuery(orgId,
      `SELECT
        (SELECT id FROM runs WHERE id < $1 ORDER BY id DESC LIMIT 1) AS prev_id,
        (SELECT id FROM runs WHERE id > $1 ORDER BY id ASC LIMIT 1) AS next_id`,
      [runId]
    );
    const { prev_id, next_id } = adjResult.rows[0] ?? {};

    const specsResult = await tenantQuery(orgId, "SELECT * FROM specs WHERE run_id = $1 ORDER BY file_path", [runId]);
    const specIds = specsResult.rows.map((s) => s.id);
    let tests: Record<number, unknown[]> = {};

    if (specIds.length > 0) {
      const testsResult = await tenantQuery(orgId, "SELECT * FROM tests WHERE spec_id = ANY($1) ORDER BY id", [specIds]);
      for (const test of testsResult.rows) {
        if (!tests[test.spec_id]) tests[test.spec_id] = [];
        tests[test.spec_id].push(test);
      }
    }

    const specs = specsResult.rows.map((spec) => ({ ...spec, tests: tests[spec.id] ?? [] }));
    res.json({ ...runResult.rows[0], specs, prev_id: prev_id ?? null, next_id: next_id ?? null });
  } catch (err) {
    console.error("GET /runs/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
