import { Router } from "express";
import { tenantQuery } from "../db.js";
import { computeFlakyTests } from "../flaky-analysis.js";

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

    // Windowed flaky detection lives in the shared module. Fetch one extra row
    // (resultLimit + 1) so we can tell whether the output was capped at
    // resultLimit without a second COUNT over the whole CTE.
    const flaky = await computeFlakyTests(orgId, {
      suite,
      runWindow: runLimit,
      limit: resultLimit + 1,
    });

    // How many runs the org actually has for this filter — lets us report
    // whether the run window truncated the available history.
    const runsAvailableResult = await tenantQuery(orgId,
      `SELECT COUNT(*)::int AS n FROM runs WHERE TRUE ${suite ? "AND suite_name = $1" : ""}`,
      suite ? [suite] : []
    );
    const runsAvailable = runsAvailableResult.rows[0].n as number;
    const runsAnalyzed = Math.min(runLimit, runsAvailable);
    const runWindowTruncated = runsAvailable > runLimit;

    // Trim the +1 probe row back to the requested page size.
    const resultsTruncated = flaky.length > resultLimit;
    const rows = resultsTruncated ? flaky.slice(0, resultLimit) : flaky;

    // Surface the window math in headers so direct API / integrator callers
    // (CI scripts, the MCP server) can tell when the classification ran over
    // a truncated window — the JSON body stays a plain array so existing
    // consumers (frontend, MCP server) don't break.
    res.setHeader("X-Flaky-Runs-Analyzed", String(runsAnalyzed));
    res.setHeader("X-Flaky-Run-Window-Truncated", String(runWindowTruncated));
    res.setHeader("X-Flaky-Results-Truncated", String(resultsTruncated));

    res.json(rows);
  } catch (err) {
    console.error("GET /flaky error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
