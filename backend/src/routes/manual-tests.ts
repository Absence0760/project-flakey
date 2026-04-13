import { Router } from "express";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";
import { parseFeature, scenarioToManualSteps } from "../cucumber-parser.js";

const router = Router();

const PRIORITIES = ["low", "medium", "high", "critical"];
const STATUSES = ["not_run", "passed", "failed", "blocked", "skipped"];

// Stable identity for a Cucumber scenario: <feature file>::<scenario name>.
// Re-importing the same file upserts in place as long as the scenario name
// isn't renamed. Rename ⇒ new manual test (we treat it as a different case).
function cucumberRef(file: string, scenarioName: string): string {
  return `${file}::${scenarioName}`;
}

// GET /manual-tests
router.get("/", async (req, res) => {
  try {
    const suite = req.query.suite as string | undefined;
    const status = req.query.status as string | undefined;
    const where: string[] = [];
    const params: unknown[] = [];
    if (suite) { params.push(suite); where.push(`suite_name = $${params.length}`); }
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const result = await tenantQuery(
      req.user!.orgId,
      `WITH auto_latest AS (
         SELECT DISTINCT ON (s.file_path, t.title)
                s.file_path, t.title, t.status, r.created_at
           FROM tests t
           JOIN specs s ON s.id = t.spec_id
           JOIN runs  r ON r.id = s.run_id
           ORDER BY s.file_path, t.title, r.created_at DESC
       )
       SELECT mt.id, mt.suite_name, mt.title, mt.description, mt.priority, mt.status,
              mt.last_run_at, mt.last_run_notes, mt.last_step_results,
              mt.automated_test_key, mt.tags,
              mt.source, mt.source_ref, mt.source_file,
              mt.created_at, mt.updated_at,
              u.email AS last_run_by_email,
              a.status     AS auto_last_status,
              a.created_at AS auto_last_run_at
       FROM manual_tests mt
       LEFT JOIN users u ON u.id = mt.last_run_by
       LEFT JOIN auto_latest a
              ON mt.source = 'cucumber'
             AND a.file_path LIKE '%' || mt.source_file
             AND a.title = mt.title
       ${whereClause}
       ORDER BY mt.updated_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /manual-tests error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /manual-tests/summary
router.get("/summary", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'passed')::int  AS passed,
         COUNT(*) FILTER (WHERE status = 'failed')::int  AS failed,
         COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked,
         COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
         COUNT(*) FILTER (WHERE status = 'not_run')::int AS not_run
       FROM manual_tests`
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /manual-tests/summary error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /manual-tests/:id
router.get("/:id", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `WITH auto_latest AS (
         SELECT DISTINCT ON (s.file_path, t.title)
                s.file_path, t.title, t.status, r.created_at
           FROM tests t
           JOIN specs s ON s.id = t.spec_id
           JOIN runs  r ON r.id = s.run_id
           ORDER BY s.file_path, t.title, r.created_at DESC
       )
       SELECT mt.*, u.email AS last_run_by_email,
              a.status     AS auto_last_status,
              a.created_at AS auto_last_run_at
       FROM manual_tests mt
       LEFT JOIN users u ON u.id = mt.last_run_by
       LEFT JOIN auto_latest a
              ON mt.source = 'cucumber'
             AND a.file_path LIKE '%' || mt.source_file
             AND a.title = mt.title
       WHERE mt.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /manual-tests/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /manual-tests
router.post("/", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { suite_name, title, description, steps, expected_result, priority, automated_test_key, tags } = req.body;
    if (!title) {
      res.status(400).json({ error: "title required" });
      return;
    }
    const pri = PRIORITIES.includes(priority) ? priority : "medium";

    const result = await tenantQuery(
      req.user!.orgId,
      `INSERT INTO manual_tests
        (org_id, suite_name, title, description, steps, expected_result, priority,
         automated_test_key, tags, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        req.user!.orgId,
        suite_name ?? null,
        title,
        description ?? null,
        JSON.stringify(Array.isArray(steps) ? steps : []),
        expected_result ?? null,
        pri,
        automated_test_key ?? null,
        Array.isArray(tags) ? tags : [],
        req.user!.id,
      ]
    );
    await logAudit(req.user!.orgId, req.user!.id, "manual_test.create", "manual_test", String(result.rows[0].id), { title });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /manual-tests error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /manual-tests/import-features — bulk import .feature files
//
// Body: { files: [{ path: string, content: string }] }
//
// Each scenario becomes a manual test with source='cucumber' and
// source_ref=<path>::<scenario name>. Re-importing upserts in place, so the
// import is safe to run on every CI cycle.
router.post("/import-features", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const files = req.body?.files;
    if (!Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: "files array required" });
      return;
    }

    let created = 0;
    let updated = 0;
    let scanned = 0;
    const errors: Array<{ file: string; error: string }> = [];

    for (const f of files) {
      if (typeof f?.path !== "string" || typeof f?.content !== "string") {
        errors.push({ file: String(f?.path ?? "?"), error: "invalid entry" });
        continue;
      }
      try {
        const feature = parseFeature(f.content);
        if (!feature.name && feature.scenarios.length === 0) {
          errors.push({ file: f.path, error: "no scenarios found" });
          continue;
        }
        for (const scenario of feature.scenarios) {
          scanned++;
          const steps = scenarioToManualSteps(feature, scenario);
          const tags = scenario.tags.map((t) => t.replace(/^@/, ""));
          const ref = cucumberRef(f.path, scenario.name);

          const result = await tenantQuery(
            req.user!.orgId,
            `INSERT INTO manual_tests
               (org_id, suite_name, title, description, steps,
                priority, tags, source, source_ref, source_file, created_by)
             VALUES ($1,$2,$3,$4,$5,'medium',$6,'cucumber',$7,$8,$9)
             ON CONFLICT (org_id, source, source_ref)
               WHERE source_ref IS NOT NULL
             DO UPDATE SET
               title       = EXCLUDED.title,
               suite_name  = EXCLUDED.suite_name,
               description = EXCLUDED.description,
               steps       = EXCLUDED.steps,
               tags        = EXCLUDED.tags,
               source_file = EXCLUDED.source_file,
               updated_at  = NOW()
             RETURNING (xmax = 0) AS inserted`,
            [
              req.user!.orgId,
              feature.name || null,
              scenario.name,
              feature.description || null,
              JSON.stringify(steps),
              tags,
              ref,
              f.path,
              req.user!.id,
            ]
          );
          if (result.rows[0]?.inserted) created++;
          else updated++;
        }
      } catch (err) {
        errors.push({ file: f.path, error: (err as Error).message });
      }
    }

    await logAudit(
      req.user!.orgId,
      req.user!.id,
      "manual_test.import",
      "manual_test",
      undefined,
      { files: files.length, created, updated, scanned }
    );
    res.json({ created, updated, scanned, errors });
  } catch (err) {
    console.error("POST /manual-tests/import-features error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /manual-tests/:id
router.patch("/:id", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }

    // Imported (source='cucumber') tests are owned by the feature file —
    // editing them here would silently drift from the source of truth and
    // be clobbered on the next import. Force changes to happen in the
    // .feature file instead.
    const existing = await tenantQuery(
      req.user!.orgId,
      "SELECT source FROM manual_tests WHERE id = $1",
      [req.params.id]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (existing.rows[0].source === "cucumber") {
      res
        .status(409)
        .json({ error: "Imported scenarios are read-only. Edit the .feature file and re-import." });
      return;
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const body = req.body;

    const assign = (col: string, val: unknown) => {
      sets.push(`${col} = $${i++}`);
      params.push(val);
    };

    if (body.title !== undefined) assign("title", body.title);
    if (body.description !== undefined) assign("description", body.description);
    if (body.suite_name !== undefined) assign("suite_name", body.suite_name);
    if (body.steps !== undefined) assign("steps", JSON.stringify(Array.isArray(body.steps) ? body.steps : []));
    if (body.expected_result !== undefined) assign("expected_result", body.expected_result);
    if (body.priority !== undefined && PRIORITIES.includes(body.priority)) assign("priority", body.priority);
    if (body.automated_test_key !== undefined) assign("automated_test_key", body.automated_test_key);
    if (body.tags !== undefined) assign("tags", Array.isArray(body.tags) ? body.tags : []);

    sets.push(`updated_at = NOW()`);

    if (sets.length === 1) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    params.push(req.params.id);
    await tenantQuery(
      req.user!.orgId,
      `UPDATE manual_tests SET ${sets.join(", ")} WHERE id = $${i}`,
      params
    );
    await logAudit(req.user!.orgId, req.user!.id, "manual_test.update", "manual_test", req.params.id);
    res.json({ updated: true });
  } catch (err) {
    console.error("PATCH /manual-tests/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Per-step statuses the runner UI can record. 'passed' covers the default
// "step succeeded" case; the other three mirror the overall test statuses so
// an aggregated run can be derived without ambiguity.
const STEP_STATUSES = ["passed", "failed", "blocked", "skipped"];

// Aggregate per-step statuses into a single overall status. Failure wins
// over anything else, then blocked, then skipped, then passed. An empty list
// falls back to not_run so we don't record ghost executions.
function deriveOverallStatus(stepResults: Array<{ status: string }>): string {
  if (!stepResults.length) return "not_run";
  if (stepResults.some((s) => s.status === "failed")) return "failed";
  if (stepResults.some((s) => s.status === "blocked")) return "blocked";
  if (stepResults.every((s) => s.status === "skipped")) return "skipped";
  return "passed";
}

// POST /manual-tests/:id/result — record an execution outcome
//
// Accepts either:
//   { status, notes }                      — classic whole-test result
//   { step_results: [{status, comment}], notes } — step-by-step runner; the
//     overall status is derived from the step statuses
// Callers may pass both, in which case an explicit `status` wins.
router.post("/:id/result", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { status, notes, step_results } = req.body;

    let normalizedSteps: Array<{ status: string; comment: string }> = [];
    if (step_results !== undefined) {
      if (!Array.isArray(step_results)) {
        res.status(400).json({ error: "step_results must be an array" });
        return;
      }
      for (const r of step_results) {
        if (!r || !STEP_STATUSES.includes(r.status)) {
          res.status(400).json({ error: "Invalid step result status" });
          return;
        }
        normalizedSteps.push({
          status: r.status,
          comment: typeof r.comment === "string" ? r.comment : "",
        });
      }
    }

    const finalStatus =
      status ?? (normalizedSteps.length ? deriveOverallStatus(normalizedSteps) : undefined);
    if (!STATUSES.includes(finalStatus)) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }

    await tenantQuery(
      req.user!.orgId,
      `UPDATE manual_tests
         SET status = $1, last_run_at = NOW(), last_run_by = $2,
             last_run_notes = $3, last_step_results = $4::jsonb,
             updated_at = NOW()
         WHERE id = $5`,
      [
        finalStatus,
        req.user!.id,
        notes ?? null,
        JSON.stringify(normalizedSteps),
        req.params.id,
      ]
    );
    await logAudit(
      req.user!.orgId,
      req.user!.id,
      "manual_test.result",
      "manual_test",
      req.params.id,
      { status: finalStatus, stepCount: normalizedSteps.length }
    );
    res.json({ updated: true, status: finalStatus });
  } catch (err) {
    console.error("POST /manual-tests/:id/result error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /manual-tests/:id
router.delete("/:id", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    await tenantQuery(
      req.user!.orgId,
      "DELETE FROM manual_tests WHERE id = $1",
      [req.params.id]
    );
    await logAudit(req.user!.orgId, req.user!.id, "manual_test.delete", "manual_test", req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE /manual-tests/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
