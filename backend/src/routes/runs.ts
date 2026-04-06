import { Router } from "express";
import { tenantQuery, tenantTransaction } from "../db.js";
import { normalize } from "../normalizers/index.js";
import { logAudit } from "../audit.js";
import { dispatchWebhooks } from "../webhooks.js";
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

    await tenantTransaction(orgId, async (client) => {
      const runResult = await client.query(
        `INSERT INTO runs (suite_name, branch, commit_sha, ci_run_id, reporter, started_at, finished_at, total, passed, failed, skipped, pending, duration_ms, org_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [
          run.meta.suite_name, run.meta.branch, run.meta.commit_sha,
          run.meta.ci_run_id, run.meta.reporter, run.meta.started_at, run.meta.finished_at,
          run.stats.total, run.stats.passed, run.stats.failed,
          run.stats.skipped, run.stats.pending, run.stats.duration_ms,
          orgId,
        ]
      );
      runId = runResult.rows[0].id;

      for (const spec of run.specs) {
        const specResult = await client.query(
          `INSERT INTO specs (run_id, file_path, title, total, passed, failed, skipped, duration_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [runId, spec.file_path, spec.title, spec.stats.total, spec.stats.passed, spec.stats.failed, spec.stats.skipped, spec.stats.duration_ms]
        );
        const specId = specResult.rows[0].id;

        for (const test of spec.tests) {
          await client.query(
            `INSERT INTO tests (spec_id, title, full_title, status, duration_ms, error_message, error_stack, screenshot_paths, video_path, test_code, command_log, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [specId, test.title, test.full_title, test.status, test.duration_ms,
             test.error?.message ?? null, test.error?.stack ?? null,
             test.screenshot_paths, test.video_path ?? null,
             test.test_code ?? null, test.command_log ? JSON.stringify(test.command_log) : null,
             test.metadata ? JSON.stringify(test.metadata) : null]
          );
        }
      }
    });

    logAudit(req.user!.orgId, req.user!.id, "run.upload", "run", String(runId!), { suite: run.meta.suite_name, total: run.stats.total, failed: run.stats.failed });

    if (run.stats.failed > 0) {
      dispatchWebhooks(req.user!.orgId, "run.failed", {
        text: `Run #${runId!} failed: ${run.stats.failed}/${run.stats.total} tests failed in suite '${run.meta.suite_name}'`,
        event: "run.failed",
        run: { id: runId!, suite_name: run.meta.suite_name, failed: run.stats.failed, total: run.stats.total },
      });
    }

    res.status(201).json({ id: runId! });
  } catch (err) {
    console.error("POST /runs error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /runs
router.get("/", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      "SELECT * FROM runs ORDER BY created_at DESC LIMIT 50"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /runs error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /runs/:id
router.get("/:id", async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const runId = req.params.id;

    const runResult = await tenantQuery(orgId, "SELECT * FROM runs WHERE id = $1", [runId]);
    if (runResult.rows.length === 0) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

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
    res.json({ ...runResult.rows[0], specs });
  } catch (err) {
    console.error("GET /runs/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
