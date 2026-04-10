import { Router } from "express";
import { tenantQuery } from "../db.js";

const router = Router();

// GET /tests/:id — single test with spec info and prev/next navigation
router.get("/:id", async (req, res) => {
  try {
    const testId = req.params.id;

    const orgId = req.user!.orgId;

    const testResult = await tenantQuery(orgId,
      `SELECT t.*, s.file_path, s.run_id, s.title AS spec_title
       FROM tests t
       JOIN specs s ON s.id = t.spec_id
       WHERE t.id = $1`,
      [testId]
    );

    if (testResult.rows.length === 0) {
      res.status(404).json({ error: "Test not found" });
      return;
    }

    const test = testResult.rows[0];

    // Get prev/next failed tests within the same run
    const failedInRun = await tenantQuery(orgId,
      `SELECT t.id FROM tests t
       JOIN specs s ON s.id = t.spec_id
       WHERE s.run_id = $1 AND t.status = 'failed'
       ORDER BY t.id`,
      [test.run_id]
    );

    const failedIds = failedInRun.rows.map((r: { id: number }) => r.id);
    const currentIndex = failedIds.indexOf(test.id);

    res.json({
      ...test,
      prev_failed_id: currentIndex > 0 ? failedIds[currentIndex - 1] : null,
      next_failed_id: currentIndex < failedIds.length - 1 ? failedIds[currentIndex + 1] : null,
      failed_index: currentIndex + 1,
      failed_total: failedIds.length,
    });
  } catch (err) {
    console.error("GET /tests/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /tests/:id/history — pass/fail timeline for this test across runs
router.get("/:id/history", async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const testId = req.params.id;

    // Get the test's title and file_path to find matching tests
    const testResult = await tenantQuery(orgId,
      `SELECT t.title, s.file_path
       FROM tests t JOIN specs s ON s.id = t.spec_id
       WHERE t.id = $1`,
      [testId]
    );

    if (testResult.rows.length === 0) {
      res.status(404).json({ error: "Test not found" });
      return;
    }

    const { title, file_path } = testResult.rows[0];

    // Find all instances of this test across runs
    const history = await tenantQuery(orgId, `
      SELECT
        t.id AS test_id,
        t.status,
        t.duration_ms,
        t.error_message,
        r.id AS run_id,
        r.suite_name,
        r.branch,
        r.created_at
      FROM tests t
      JOIN specs s ON s.id = t.spec_id
      JOIN runs r ON r.id = s.run_id
      WHERE t.title = $1 AND s.file_path = $2
      ORDER BY r.created_at DESC
      LIMIT 50
    `, [title, file_path]);

    res.json({
      title,
      file_path,
      history: history.rows,
    });
  } catch (err) {
    console.error("GET /tests/:id/history error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /tests/slowest — slowest tests with percentiles, trend, and duration timeline
router.get("/slowest/list", async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const suite = req.query.suite as string | undefined;

    let suiteFilter = "";
    const params: unknown[] = [limit];

    if (suite) {
      suiteFilter = "AND r.suite_name = $2";
      params.push(suite);
    }

    const result = await tenantQuery(orgId, `
      SELECT
        t.title,
        s.file_path,
        r.suite_name,
        ROUND(AVG(t.duration_ms))::int AS avg_duration_ms,
        MAX(t.duration_ms)::int AS max_duration_ms,
        MIN(t.duration_ms)::int AS min_duration_ms,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY t.duration_ms))::int AS p50_ms,
        ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY t.duration_ms))::int AS p95_ms,
        ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY t.duration_ms))::int AS p99_ms,
        COUNT(*)::int AS run_count,
        MAX(r.created_at) AS last_seen,
        MIN(r.created_at) AS first_seen,
        ARRAY_AGG(t.duration_ms ORDER BY r.created_at ASC) AS duration_history
      FROM tests t
      JOIN specs s ON s.id = t.spec_id
      JOIN runs r ON r.id = s.run_id
      WHERE t.status = 'passed'
      ${suiteFilter}
      GROUP BY t.title, s.file_path, r.suite_name
      HAVING COUNT(*) >= 2
      ORDER BY avg_duration_ms DESC
      LIMIT $1
    `, params);

    // Compute trend: compare avg of first half vs second half of duration_history
    const rows = result.rows.map((row) => {
      const history: number[] = row.duration_history;
      const mid = Math.floor(history.length / 2);
      if (mid === 0) {
        return { ...row, trend_pct: 0 };
      }
      const firstHalf = history.slice(0, mid);
      const secondHalf = history.slice(mid);
      const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
      const trendPct = avgFirst > 0 ? Math.round(((avgSecond - avgFirst) / avgFirst) * 100) : 0;
      return { ...row, trend_pct: trendPct };
    });

    res.json(rows);
  } catch (err) {
    console.error("GET /tests/slowest error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /tests/search/list — search for automated tests to link to manual tests.
//
// Returns up to `limit` distinct (file_path, full_title) pairs matching `q`,
// ranked by most-recently-seen. Each result includes the latest known status
// and run id so the caller can show whether the automated counterpart is
// currently passing.
//
// ?mode=files returns distinct spec file paths instead of individual tests,
// for users who want to link a manual test to an entire spec rather than
// one specific test within it.
router.get("/search/list", async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const q = ((req.query.q as string) ?? "").trim();
    const mode = (req.query.mode as string) === "files" ? "files" : "tests";
    const limit = Math.min(Number(req.query.limit) || 20, 50);

    if (q.length < 2) {
      res.json([]);
      return;
    }

    const pattern = `%${q}%`;

    if (mode === "files") {
      const result = await tenantQuery(
        orgId,
        `SELECT
           s.file_path,
           r.suite_name,
           COUNT(DISTINCT t.full_title)::int AS test_count,
           MAX(r.created_at) AS last_run_at
         FROM tests t
         JOIN specs s ON s.id = t.spec_id
         JOIN runs  r ON r.id = s.run_id
         WHERE s.file_path ILIKE $1
         GROUP BY s.file_path, r.suite_name
         ORDER BY last_run_at DESC
         LIMIT $2`,
        [pattern, limit]
      );
      res.json(result.rows);
      return;
    }

    // mode === "tests": distinct (file_path, full_title) with most-recent status
    const result = await tenantQuery(
      orgId,
      `WITH latest AS (
         SELECT
           s.file_path,
           t.full_title,
           r.suite_name,
           t.status,
           t.id     AS test_id,
           r.id     AS run_id,
           r.created_at,
           ROW_NUMBER() OVER (
             PARTITION BY s.file_path, t.full_title
             ORDER BY r.created_at DESC
           ) AS rn
         FROM tests t
         JOIN specs s ON s.id = t.spec_id
         JOIN runs  r ON r.id = s.run_id
         WHERE t.full_title ILIKE $1 OR s.file_path ILIKE $1
       )
       SELECT file_path, full_title, suite_name, status, test_id, run_id, created_at AS last_run_at
       FROM latest
       WHERE rn = 1
       ORDER BY created_at DESC
       LIMIT $2`,
      [pattern, limit]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /tests/search/list error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
