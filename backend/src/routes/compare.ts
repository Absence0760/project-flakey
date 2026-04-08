import { Router } from "express";
import { tenantQuery } from "../db.js";

const router = Router();

// GET /compare?a=42&b=43
router.get("/", async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const runIdA = Number(req.query.a);
    const runIdB = Number(req.query.b);

    if (!runIdA || !runIdB) {
      res.status(400).json({ error: "Query params 'a' and 'b' (run IDs) are required" });
      return;
    }

    // Fetch both runs
    const [runA, runB] = await Promise.all([
      tenantQuery(orgId, "SELECT * FROM runs WHERE id = $1", [runIdA]),
      tenantQuery(orgId, "SELECT * FROM runs WHERE id = $1", [runIdB]),
    ]);

    if (runA.rows.length === 0 || runB.rows.length === 0) {
      res.status(404).json({ error: "One or both runs not found" });
      return;
    }

    // Fetch all tests for both runs
    const [testsA, testsB] = await Promise.all([
      tenantQuery(orgId, `
        SELECT t.id, t.title, t.status, t.duration_ms, t.error_message, s.file_path
        FROM tests t JOIN specs s ON s.id = t.spec_id
        WHERE s.run_id = $1
        ORDER BY s.file_path, t.id
      `, [runIdA]),
      tenantQuery(orgId, `
        SELECT t.id, t.title, t.status, t.duration_ms, t.error_message, s.file_path
        FROM tests t JOIN specs s ON s.id = t.spec_id
        WHERE s.run_id = $1
        ORDER BY s.file_path, t.id
      `, [runIdB]),
    ]);

    // Build lookup by file_path + title
    const mapA = new Map<string, typeof testsA.rows[0]>();
    for (const t of testsA.rows) {
      mapA.set(`${t.file_path}::${t.title}`, t);
    }

    const mapB = new Map<string, typeof testsB.rows[0]>();
    for (const t of testsB.rows) {
      mapB.set(`${t.file_path}::${t.title}`, t);
    }

    // All unique keys
    const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);

    const comparisons: {
      key: string;
      file_path: string;
      title: string;
      category: string;
      a: { id: number; status: string; duration_ms: number; error_message: string | null } | null;
      b: { id: number; status: string; duration_ms: number; error_message: string | null } | null;
      duration_delta: number | null;
    }[] = [];

    for (const key of allKeys) {
      const a = mapA.get(key) ?? null;
      const b = mapB.get(key) ?? null;
      const [file_path, title] = key.split("::");

      let category: string;
      if (!a) {
        category = "added";
      } else if (!b) {
        category = "removed";
      } else if (a.status === "passed" && b.status === "failed") {
        category = "regression";
      } else if (a.status === "failed" && b.status === "passed") {
        category = "fixed";
      } else if (a.status === "failed" && b.status === "failed") {
        category = "still_failing";
      } else if (a.status !== "failed" && b.status !== "failed" && a.status !== b.status) {
        category = "changed";
      } else {
        category = "unchanged";
      }

      let durationDelta: number | null = null;
      if (a && b && a.duration_ms > 0) {
        durationDelta = Math.round(((b.duration_ms - a.duration_ms) / a.duration_ms) * 100);
      }

      comparisons.push({
        key,
        file_path,
        title,
        category,
        a: a ? { id: a.id, status: a.status, duration_ms: a.duration_ms, error_message: a.error_message } : null,
        b: b ? { id: b.id, status: b.status, duration_ms: b.duration_ms, error_message: b.error_message } : null,
        duration_delta: durationDelta,
      });
    }

    // Sort: regressions first, then fixed, still_failing, added, removed, changed, unchanged
    const order: Record<string, number> = { regression: 0, fixed: 1, still_failing: 2, added: 3, removed: 4, changed: 5, unchanged: 6 };
    comparisons.sort((x, y) => (order[x.category] ?? 9) - (order[y.category] ?? 9));

    // Summary counts
    const summary: Record<string, number> = {};
    for (const c of comparisons) {
      summary[c.category] = (summary[c.category] ?? 0) + 1;
    }

    res.json({
      run_a: runA.rows[0],
      run_b: runB.rows[0],
      summary,
      comparisons,
    });
  } catch (err) {
    console.error("GET /compare error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /compare/suites — latest 2 runs per suite, with summary diffs
router.get("/suites", async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

    let dateFilter = "";
    const params: string[] = [];

    if (from && to) {
      params.push(from, to);
      dateFilter = `WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')`;
    } else if (from) {
      params.push(from);
      dateFilter = `WHERE created_at >= $1::date`;
    } else if (to) {
      params.push(to);
      dateFilter = `WHERE created_at < ($1::date + INTERVAL '1 day')`;
    }

    // Get latest 2 runs per suite using window function
    const result = await tenantQuery(orgId, `
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY suite_name ORDER BY created_at DESC) AS rn
        FROM runs
        ${dateFilter}
      ) sub
      WHERE rn <= 2
      ORDER BY suite_name, rn
    `, params);

    // Group by suite
    const suiteMap = new Map<string, typeof result.rows>();
    for (const row of result.rows) {
      const list = suiteMap.get(row.suite_name) || [];
      list.push(row);
      suiteMap.set(row.suite_name, list);
    }

    const suites = [];
    for (const [suite_name, runs] of suiteMap) {
      const latest = runs[0];
      const previous = runs[1] ?? null;

      const diff: Record<string, number> = {};
      if (previous) {
        diff.total = latest.total - previous.total;
        diff.passed = latest.passed - previous.passed;
        diff.failed = latest.failed - previous.failed;
        diff.skipped = latest.skipped - previous.skipped;
        diff.duration_ms = latest.duration_ms - previous.duration_ms;
        diff.pass_rate = (latest.total > 0 ? latest.passed / latest.total : 0) - (previous.total > 0 ? previous.passed / previous.total : 0);
        diff.pass_rate = Math.round(diff.pass_rate * 1000) / 10; // one decimal
      }

      suites.push({
        suite_name,
        latest: { id: latest.id, total: latest.total, passed: latest.passed, failed: latest.failed, skipped: latest.skipped, duration_ms: latest.duration_ms, branch: latest.branch, created_at: latest.created_at },
        previous: previous ? { id: previous.id, total: previous.total, passed: previous.passed, failed: previous.failed, skipped: previous.skipped, duration_ms: previous.duration_ms, branch: previous.branch, created_at: previous.created_at } : null,
        diff: previous ? diff : null,
      });
    }

    res.json(suites);
  } catch (err) {
    console.error("GET /compare/suites error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
