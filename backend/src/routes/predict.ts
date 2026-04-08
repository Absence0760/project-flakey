import { Router } from "express";
import { tenantQuery } from "../db.js";

const router = Router();

/**
 * POST /predict/tests — predict which tests to run based on changed files.
 *
 * Strategy: find tests that have historically failed when the given files were
 * part of a commit, plus tests in spec files that share path segments with
 * the changed files. This is a heuristic, not ML — but it's fast, cheap,
 * and surprisingly effective.
 *
 * Body: { changedFiles: string[], suite?: string }
 * Returns: { tests: Array<{ full_title, file_path, score, reason }> }
 */
router.post("/tests", async (req, res) => {
  try {
    const { changedFiles, suite } = req.body as { changedFiles: string[]; suite?: string };
    if (!changedFiles || changedFiles.length === 0) {
      res.status(400).json({ error: "changedFiles array is required" });
      return;
    }

    const orgId = req.user!.orgId;

    // Extract directory/module segments from changed files
    const segments = new Set<string>();
    for (const file of changedFiles) {
      const parts = file.replace(/\\/g, "/").split("/");
      // Add each directory and the filename without extension
      for (const part of parts) {
        const clean = part.replace(/\.[^.]+$/, "").toLowerCase();
        if (clean.length >= 3 && !["src", "lib", "test", "tests", "spec", "index", "main", "app"].includes(clean)) {
          segments.add(clean);
        }
      }
    }

    if (segments.size === 0) {
      res.json({ tests: [] });
      return;
    }

    const segmentArray = Array.from(segments);

    // Find tests whose spec file_path contains any of the segments
    // and that have failed at least once (higher priority for frequent failures)
    let suiteFilter = "";
    const params: unknown[] = [segmentArray];
    let paramIndex = 2;

    if (suite) {
      suiteFilter = `AND r.suite_name = $${paramIndex++}`;
      params.push(suite);
    }

    const result = await tenantQuery(orgId,
      `WITH matched_tests AS (
        SELECT DISTINCT ON (t.full_title, s.file_path)
          t.full_title,
          s.file_path,
          t.status,
          r.suite_name,
          COUNT(*) FILTER (WHERE t.status = 'failed') OVER (PARTITION BY t.full_title) AS historical_failures,
          COUNT(*) OVER (PARTITION BY t.full_title) AS total_appearances
        FROM tests t
        JOIN specs s ON s.id = t.spec_id
        JOIN runs r ON r.id = s.run_id
        WHERE EXISTS (
          SELECT 1 FROM unnest($1::text[]) seg
          WHERE LOWER(s.file_path) LIKE '%' || seg || '%'
             OR LOWER(t.full_title) LIKE '%' || seg || '%'
        )
        ${suiteFilter}
        ORDER BY t.full_title, s.file_path, r.created_at DESC
      )
      SELECT full_title, file_path, suite_name,
        historical_failures::int,
        total_appearances::int,
        CASE
          WHEN historical_failures > 0 THEN 'previously_failed'
          ELSE 'path_match'
        END AS reason
      FROM matched_tests
      ORDER BY historical_failures DESC, total_appearances DESC
      LIMIT 50`,
      params
    );

    const tests = result.rows.map((row: any) => ({
      full_title: row.full_title,
      file_path: row.file_path,
      suite_name: row.suite_name,
      score: row.historical_failures > 0
        ? Math.min(1, 0.5 + (row.historical_failures / row.total_appearances) * 0.5)
        : 0.3,
      reason: row.reason,
      historical_failures: row.historical_failures,
    }));

    res.json({ tests });
  } catch (err) {
    console.error("POST /predict/tests error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /predict/split — split specs across N workers balanced by historical duration.
 *
 * Query: ?suite=name&workers=4
 * Returns: { workers: Array<{ index, specs: string[], estimated_ms }> }
 *
 * Uses greedy bin-packing: sort specs by duration descending, assign each to
 * the worker with the least total time so far.
 */
router.get("/split", async (req, res) => {
  try {
    const suite = req.query.suite as string | undefined;
    const workerCount = Math.max(1, Math.min(Number(req.query.workers) || 2, 50));

    if (!suite) {
      res.status(400).json({ error: "suite query parameter is required" });
      return;
    }

    const orgId = req.user!.orgId;

    // Get average duration per spec from recent runs
    const result = await tenantQuery(orgId,
      `SELECT s.file_path,
        COALESCE(AVG(s.duration_ms), 0)::bigint AS avg_duration_ms,
        COUNT(*)::int AS run_count
       FROM specs s
       JOIN runs r ON r.id = s.run_id
       WHERE r.suite_name = $1
         AND r.created_at > NOW() - INTERVAL '30 days'
       GROUP BY s.file_path
       ORDER BY avg_duration_ms DESC`,
      [suite]
    );

    if (result.rows.length === 0) {
      // No history — just round-robin
      const specs = await tenantQuery(orgId,
        `SELECT DISTINCT s.file_path
         FROM specs s JOIN runs r ON r.id = s.run_id
         WHERE r.suite_name = $1
         ORDER BY s.file_path`,
        [suite]
      );
      const workers = Array.from({ length: workerCount }, (_, i) => ({
        index: i,
        specs: [] as string[],
        estimated_ms: 0,
      }));
      specs.rows.forEach((row: any, i: number) => {
        workers[i % workerCount].specs.push(row.file_path);
      });
      res.json({ workers, strategy: "round_robin" });
      return;
    }

    // Greedy bin-packing: assign heaviest specs first to lightest worker
    const workers = Array.from({ length: workerCount }, (_, i) => ({
      index: i,
      specs: [] as string[],
      estimated_ms: 0,
    }));

    for (const row of result.rows) {
      const lightest = workers.reduce((a, b) => a.estimated_ms <= b.estimated_ms ? a : b);
      lightest.specs.push(row.file_path);
      lightest.estimated_ms += Number(row.avg_duration_ms);
    }

    res.json({ workers, strategy: "balanced" });
  } catch (err) {
    console.error("GET /predict/split error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
