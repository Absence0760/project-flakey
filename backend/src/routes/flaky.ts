import { Router } from "express";
import { tenantQuery } from "../db.js";

const router = Router();

// GET /flaky — server-side flaky test detection
// Query params: ?suite=name&limit=50&runs=30
router.get("/", async (req, res) => {
  try {
    const suite = req.query.suite as string | undefined;
    // Run window: how many recent runs feed the classification. Default 30
    // (recent-flakiness view); ceiling raised 100 -> 500 so a caller that
    // wants a deeper analysis can ask for it instead of silently getting a
    // truncated window. The actual window used and whether it truncated the
    // available runs are surfaced via response headers below.
    const runLimit = Math.min(Number(req.query.runs) || 30, 500);
    const resultLimit = Math.min(Number(req.query.limit) || 50, 200);
    const orgId = req.user!.orgId;

    // Build the run filter. The runs CTE references the table without an
    // alias, so `suite_name` is the correct unqualified column name —
    // earlier code wrote `r.suite_name` here which produced
    // `missing FROM-clause entry for table "r"` whenever a suite was
    // supplied (the unfiltered case happened to work because the empty
    // filter string never referenced the alias).
    let runFilter = "";
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (suite) {
      runFilter = `AND suite_name = $${paramIndex++}`;
      params.push(suite);
    }

    // Get flaky tests: tests that have both passed and failed across recent runs,
    // with their full status timeline
    const result = await tenantQuery(orgId,
      `WITH recent_runs AS (
        SELECT id, suite_name, created_at
        FROM runs
        WHERE TRUE ${runFilter}
        ORDER BY created_at DESC
        LIMIT $${paramIndex++}
      ),
      test_results AS (
        SELECT
          t.full_title,
          t.title,
          s.file_path,
          r.suite_name,
          t.status,
          r.created_at AS run_date,
          r.id AS run_id
        FROM tests t
        JOIN specs s ON s.id = t.spec_id
        JOIN recent_runs r ON r.id = s.run_id
        WHERE t.status IN ('passed', 'failed')
      ),
      flaky_candidates AS (
        SELECT
          full_title,
          title,
          file_path,
          suite_name,
          COUNT(*)::int AS total_runs,
          COUNT(*) FILTER (WHERE status = 'passed')::int AS pass_count,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS fail_count,
          MIN(run_date) AS first_seen,
          MAX(run_date) AS last_seen,
          ARRAY_AGG(status ORDER BY run_date ASC) AS timeline,
          ARRAY_AGG(run_id ORDER BY run_date ASC) AS run_ids,
          MAX(run_id) AS latest_run_id
        FROM test_results
        GROUP BY full_title, title, file_path, suite_name
        HAVING COUNT(*) FILTER (WHERE status = 'passed') > 0
           AND COUNT(*) FILTER (WHERE status = 'failed') > 0
      )
      SELECT *,
        ROUND(fail_count::numeric / total_runs * 100, 1) AS flaky_rate
      FROM flaky_candidates
      ORDER BY flaky_rate DESC, fail_count DESC
      LIMIT $${paramIndex++}`,
      // Fetch one extra row so we can tell whether the output was capped at
      // resultLimit without a second COUNT over the whole CTE.
      [...params, runLimit, resultLimit + 1]
    );

    // How many runs the org actually has for this filter — lets us report
    // whether the run window truncated the available history.
    const runsAvailableResult = await tenantQuery(orgId,
      `SELECT COUNT(*)::int AS n FROM runs WHERE TRUE ${runFilter}`,
      suite ? [suite] : []
    );
    const runsAvailable = runsAvailableResult.rows[0].n as number;
    const runsAnalyzed = Math.min(runLimit, runsAvailable);
    const runWindowTruncated = runsAvailable > runLimit;

    // Trim the +1 probe row back to the requested page size.
    const resultsTruncated = result.rows.length > resultLimit;
    const pageRows = resultsTruncated ? result.rows.slice(0, resultLimit) : result.rows;

    // Surface the window math in headers so direct API / integrator callers
    // (CI scripts, the MCP server) can tell when the classification ran over
    // a truncated window — the JSON body stays a plain array so existing
    // consumers (frontend, MCP server) don't break.
    res.setHeader("X-Flaky-Runs-Analyzed", String(runsAnalyzed));
    res.setHeader("X-Flaky-Run-Window-Truncated", String(runWindowTruncated));
    res.setHeader("X-Flaky-Results-Truncated", String(resultsTruncated));

    // Compute flip count from timeline
    const rows = pageRows.map((row) => {
      const timeline: string[] = row.timeline;
      let flipCount = 0;
      for (let i = 1; i < timeline.length; i++) {
        if (timeline[i] !== timeline[i - 1]) flipCount++;
      }
      return {
        ...row,
        flip_count: flipCount,
        total_runs: row.total_runs,
        pass_count: row.pass_count,
        fail_count: row.fail_count,
        flaky_rate: Number(row.flaky_rate),
      };
    });

    res.json(rows);
  } catch (err) {
    console.error("GET /flaky error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
