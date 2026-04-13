import { Router } from "express";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";
import {
  getJiraConfig,
  fetchProjectVersions,
  findVersionByName,
  fetchVersionIssueCounts,
  fetchIssuesForVersion,
  type JiraVersion,
} from "../integrations/jira.js";

const router = Router();

const STATUSES = ["draft", "in_progress", "signed_off", "released", "cancelled"];

// Two of the default checklist items are wired to live data via an
// `auto_rule`. The rules are evaluated server-side on every GET, so the
// checkbox reflects reality instead of whoever last clicked it.
const RULE_CRITICAL_TESTS_PASSING = "critical_tests_passing";
const RULE_MANUAL_REGRESSION_EXECUTED = "manual_regression_executed";

const DEFAULT_CHECKLIST: Array<{ label: string; required: boolean; auto_rule?: string }> = [
  { label: "All critical tests passing", required: true, auto_rule: RULE_CRITICAL_TESTS_PASSING },
  { label: "Manual regression test suite executed", required: true, auto_rule: RULE_MANUAL_REGRESSION_EXECUTED },
  { label: "Release notes drafted", required: true },
  { label: "Documentation updated", required: false },
  { label: "Stakeholders notified", required: true },
  { label: "Rollback plan prepared", required: true },
];

// ── Rule evaluation ─────────────────────────────────────────────────────
//
// Each rule returns { met, details }. The checklist item's `checked` column
// is overridden with `met` at GET time, and `details` is stored in
// auto_details so the UI can explain *why* an item is (un)checked without
// re-running the query.

interface RuleResult { met: boolean; details: string }

async function evaluateCriticalTestsPassing(
  orgId: number,
  releaseId: number
): Promise<RuleResult> {
  // Prefer runs explicitly linked to this release; otherwise fall back to the
  // single most recent run for the org so the rule still has a signal.
  const linked = await tenantQuery(
    orgId,
    `SELECT r.id, r.failed, r.total, r.passed
       FROM release_runs rr
       JOIN runs r ON r.id = rr.run_id
      WHERE rr.release_id = $1
      ORDER BY r.created_at DESC`,
    [releaseId]
  );
  let rows = linked.rows;
  let scope: "linked" | "latest" = "linked";
  if (rows.length === 0) {
    const latest = await tenantQuery(
      orgId,
      "SELECT id, failed, total, passed FROM runs ORDER BY created_at DESC LIMIT 1"
    );
    rows = latest.rows;
    scope = "latest";
  }
  if (rows.length === 0) {
    return { met: false, details: "No runs uploaded yet" };
  }
  const totalFailed = rows.reduce((sum, r) => sum + Number(r.failed ?? 0), 0);
  const totalTests  = rows.reduce((sum, r) => sum + Number(r.total  ?? 0), 0);
  const label = scope === "linked" ? `${rows.length} linked run(s)` : "latest run";
  if (totalFailed === 0) {
    return { met: true, details: `${totalTests} tests passing across ${label}` };
  }
  return { met: false, details: `${totalFailed} failing test(s) across ${label}` };
}

async function evaluateManualRegressionExecuted(
  orgId: number,
  releaseId: number
): Promise<RuleResult> {
  // Prefer explicitly linked manual tests; otherwise use org-wide high/critical
  // priority manual tests as the regression suite.
  const linked = await tenantQuery(
    orgId,
    `SELECT mt.id, mt.status
       FROM release_manual_tests rmt
       JOIN manual_tests mt ON mt.id = rmt.manual_test_id
      WHERE rmt.release_id = $1`,
    [releaseId]
  );
  let rows = linked.rows;
  let scope: "linked" | "priority" = "linked";
  if (rows.length === 0) {
    const priority = await tenantQuery(
      orgId,
      "SELECT id, status FROM manual_tests WHERE priority IN ('high','critical')"
    );
    rows = priority.rows;
    scope = "priority";
  }
  if (rows.length === 0) {
    return { met: false, details: "No manual tests defined" };
  }
  const failed   = rows.filter((r) => r.status === "failed").length;
  const blocked  = rows.filter((r) => r.status === "blocked").length;
  const notRun   = rows.filter((r) => r.status === "not_run").length;
  const executed = rows.length - notRun;
  const label = scope === "linked" ? "linked manual tests" : "high/critical manual tests";
  if (failed > 0)   return { met: false, details: `${failed} failing ${label}` };
  if (blocked > 0)  return { met: false, details: `${blocked} blocked ${label}` };
  if (notRun > 0)   return { met: false, details: `${notRun} of ${rows.length} ${label} not yet run` };
  return { met: true, details: `${executed}/${rows.length} ${label} executed cleanly` };
}

async function evaluateRule(
  rule: string,
  orgId: number,
  releaseId: number
): Promise<RuleResult> {
  if (rule === RULE_CRITICAL_TESTS_PASSING)    return evaluateCriticalTestsPassing(orgId, releaseId);
  if (rule === RULE_MANUAL_REGRESSION_EXECUTED) return evaluateManualRegressionExecuted(orgId, releaseId);
  return { met: false, details: `Unknown rule: ${rule}` };
}

// Evaluate every auto-ruled checklist item for a release and push the
// results back to the DB so subsequent reads are consistent and the
// sign-off gate can trust the stored `checked` column.
async function refreshAutoItems(orgId: number, releaseId: number): Promise<void> {
  const items = await tenantQuery(
    orgId,
    "SELECT id, auto_rule FROM release_checklist_items WHERE release_id = $1 AND auto_rule IS NOT NULL",
    [releaseId]
  );
  for (const it of items.rows) {
    const result = await evaluateRule(it.auto_rule, orgId, releaseId);
    await tenantQuery(
      orgId,
      `UPDATE release_checklist_items
          SET checked       = $1,
              auto_details  = $2,
              checked_at    = CASE WHEN $1 AND checked_at IS NULL THEN NOW() ELSE checked_at END,
              checked_by    = CASE WHEN $1 AND checked_by IS NULL THEN NULL ELSE checked_by END
        WHERE id = $3`,
      [result.met, result.details, it.id]
    );
  }
}

// GET /releases
router.get("/", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT r.id, r.version, r.name, r.status, r.target_date, r.description,
              r.signed_off_at, r.created_at, r.updated_at,
              u1.email AS signed_off_by_email,
              u2.email AS created_by_email,
              (SELECT COUNT(*)::int FROM release_checklist_items WHERE release_id = r.id) AS item_count,
              (SELECT COUNT(*)::int FROM release_checklist_items WHERE release_id = r.id AND checked = true) AS checked_count,
              (SELECT COUNT(*)::int FROM release_checklist_items
                  WHERE release_id = r.id AND required = true AND checked = false) AS required_remaining
       FROM releases r
       LEFT JOIN users u1 ON u1.id = r.signed_off_by
       LEFT JOIN users u2 ON u2.id = r.created_by
       ORDER BY r.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /releases error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /releases/:id
router.get("/:id", async (req, res) => {
  try {
    const release = await tenantQuery(
      req.user!.orgId,
      `SELECT r.*, u1.email AS signed_off_by_email, u2.email AS created_by_email
       FROM releases r
       LEFT JOIN users u1 ON u1.id = r.signed_off_by
       LEFT JOIN users u2 ON u2.id = r.created_by
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (release.rows.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // Re-run every auto rule before reading so the user sees fresh state.
    await refreshAutoItems(req.user!.orgId, Number(req.params.id));

    const items = await tenantQuery(
      req.user!.orgId,
      `SELECT ci.id, ci.label, ci.required, ci.checked, ci.position, ci.notes,
              ci.auto_rule, ci.auto_details,
              ci.checked_at, u.email AS checked_by_email
       FROM release_checklist_items ci
       LEFT JOIN users u ON u.id = ci.checked_by
       WHERE release_id = $1 ORDER BY position, id`,
      [req.params.id]
    );

    const linkedRuns = await tenantQuery(
      req.user!.orgId,
      `SELECT r.id, r.suite_name, r.branch, r.commit_sha, r.total, r.passed, r.failed,
              r.skipped, r.duration_ms, r.created_at
         FROM release_runs rr
         JOIN runs r ON r.id = rr.run_id
        WHERE rr.release_id = $1
        ORDER BY r.created_at DESC`,
      [req.params.id]
    );

    const linkedManualTests = await tenantQuery(
      req.user!.orgId,
      `SELECT mt.id, mt.title, mt.suite_name, mt.priority, mt.status, mt.last_run_at
         FROM release_manual_tests rmt
         JOIN manual_tests mt ON mt.id = rmt.manual_test_id
        WHERE rmt.release_id = $1
        ORDER BY mt.priority DESC, mt.title`,
      [req.params.id]
    );

    res.json({
      ...release.rows[0],
      items: items.rows,
      linked_runs: linkedRuns.rows,
      linked_manual_tests: linkedManualTests.rows,
    });
  } catch (err) {
    console.error("GET /releases/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /releases/:id/readiness — high-level status for the readiness panel
router.get("/:id/readiness", async (req, res) => {
  try {
    const releaseId = Number(req.params.id);
    const orgId = req.user!.orgId;

    await refreshAutoItems(orgId, releaseId);

    const critical = await evaluateCriticalTestsPassing(orgId, releaseId);
    const manual   = await evaluateManualRegressionExecuted(orgId, releaseId);

    const runStats = await tenantQuery(
      orgId,
      `SELECT COUNT(*)::int AS linked,
              COALESCE(SUM(r.total),  0)::int AS total,
              COALESCE(SUM(r.passed), 0)::int AS passed,
              COALESCE(SUM(r.failed), 0)::int AS failed,
              COALESCE(SUM(r.skipped),0)::int AS skipped
         FROM release_runs rr
         JOIN runs r ON r.id = rr.run_id
        WHERE rr.release_id = $1`,
      [releaseId]
    );

    const manualStats = await tenantQuery(
      orgId,
      `SELECT COUNT(*)::int AS linked,
              COUNT(*) FILTER (WHERE mt.status = 'passed')::int  AS passed,
              COUNT(*) FILTER (WHERE mt.status = 'failed')::int  AS failed,
              COUNT(*) FILTER (WHERE mt.status = 'blocked')::int AS blocked,
              COUNT(*) FILTER (WHERE mt.status = 'skipped')::int AS skipped,
              COUNT(*) FILTER (WHERE mt.status = 'not_run')::int AS not_run
         FROM release_manual_tests rmt
         JOIN manual_tests mt ON mt.id = rmt.manual_test_id
        WHERE rmt.release_id = $1`,
      [releaseId]
    );

    const blockingItems = await tenantQuery(
      orgId,
      `SELECT id, label, auto_rule, auto_details
         FROM release_checklist_items
        WHERE release_id = $1 AND required = true AND checked = false
        ORDER BY position, id`,
      [releaseId]
    );

    res.json({
      runs: runStats.rows[0],
      manual_tests: manualStats.rows[0],
      rules: {
        [RULE_CRITICAL_TESTS_PASSING]: critical,
        [RULE_MANUAL_REGRESSION_EXECUTED]: manual,
      },
      blocking_items: blockingItems.rows,
      ready: blockingItems.rows.length === 0,
    });
  } catch (err) {
    console.error("GET /releases/:id/readiness error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /releases
router.post("/", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { version, name, target_date, description, items } = req.body;
    if (!version) {
      res.status(400).json({ error: "version required" });
      return;
    }

    const release = await tenantQuery(
      req.user!.orgId,
      `INSERT INTO releases (org_id, version, name, target_date, description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, version, name, status, target_date, description, created_at`,
      [
        req.user!.orgId,
        version,
        name ?? null,
        target_date ?? null,
        description ?? null,
        req.user!.id,
      ]
    );
    const releaseId = release.rows[0].id;

    const checklist = Array.isArray(items) && items.length > 0 ? items : DEFAULT_CHECKLIST;
    let position = 0;
    for (const it of checklist) {
      if (!it?.label) continue;
      await tenantQuery(
        req.user!.orgId,
        `INSERT INTO release_checklist_items
            (org_id, release_id, label, required, position, auto_rule)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.user!.orgId, releaseId, it.label, it.required !== false, position++, it.auto_rule ?? null]
      );
    }

    await logAudit(req.user!.orgId, req.user!.id, "release.create", "release", String(releaseId), { version });
    res.status(201).json(release.rows[0]);
  } catch (err) {
    console.error("POST /releases error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /releases/:id
router.patch("/:id", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const assign = (c: string, v: unknown) => { sets.push(`${c} = $${i++}`); params.push(v); };

    if (req.body.name !== undefined) assign("name", req.body.name);
    if (req.body.description !== undefined) assign("description", req.body.description);
    if (req.body.target_date !== undefined) assign("target_date", req.body.target_date);
    if (req.body.status !== undefined && STATUSES.includes(req.body.status)) assign("status", req.body.status);
    if (req.body.version !== undefined) assign("version", req.body.version);
    sets.push("updated_at = NOW()");

    if (sets.length === 1) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    params.push(req.params.id);
    await tenantQuery(
      req.user!.orgId,
      `UPDATE releases SET ${sets.join(", ")} WHERE id = $${i}`,
      params
    );
    await logAudit(req.user!.orgId, req.user!.id, "release.update", "release", req.params.id);
    res.json({ updated: true });
  } catch (err) {
    console.error("PATCH /releases/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /releases/:id/sign-off
router.post("/:id/sign-off", async (req, res) => {
  try {
    if (req.user!.orgRole !== "owner" && req.user!.orgRole !== "admin") {
      res.status(403).json({ error: "Admin or owner role required" });
      return;
    }
    // Refresh auto-evaluated items so the gate reflects current data.
    await refreshAutoItems(req.user!.orgId, Number(req.params.id));

    // Enforce: all required checklist items must be checked
    const remaining = await tenantQuery(
      req.user!.orgId,
      `SELECT COUNT(*)::int AS c FROM release_checklist_items
         WHERE release_id = $1 AND required = true AND checked = false`,
      [req.params.id]
    );
    if (remaining.rows[0].c > 0) {
      res.status(400).json({ error: `${remaining.rows[0].c} required checklist item(s) still unchecked` });
      return;
    }

    await tenantQuery(
      req.user!.orgId,
      `UPDATE releases SET status = 'signed_off', signed_off_by = $1, signed_off_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
      [req.user!.id, req.params.id]
    );
    await logAudit(req.user!.orgId, req.user!.id, "release.sign_off", "release", req.params.id);
    res.json({ signed_off: true });
  } catch (err) {
    console.error("POST /releases/:id/sign-off error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /releases/:id/items
router.post("/:id/items", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { label, required } = req.body;
    if (!label) {
      res.status(400).json({ error: "label required" });
      return;
    }
    const posResult = await tenantQuery(
      req.user!.orgId,
      "SELECT COALESCE(MAX(position) + 1, 0) AS pos FROM release_checklist_items WHERE release_id = $1",
      [req.params.id]
    );
    const result = await tenantQuery(
      req.user!.orgId,
      `INSERT INTO release_checklist_items (org_id, release_id, label, required, position)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user!.orgId, req.params.id, label, required !== false, posResult.rows[0].pos]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /releases/:id/items error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /releases/:releaseId/items/:itemId — toggle checked / notes
router.patch("/:releaseId/items/:itemId", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { checked, notes, label, required } = req.body;

    // Auto-ruled items are owned by the rule engine — manual toggles would
    // just be clobbered on the next read. Notes are still editable.
    if (checked !== undefined) {
      const existing = await tenantQuery(
        req.user!.orgId,
        "SELECT auto_rule FROM release_checklist_items WHERE id = $1 AND release_id = $2",
        [req.params.itemId, req.params.releaseId]
      );
      if (existing.rows[0]?.auto_rule) {
        res.status(409).json({ error: "This item is auto-evaluated and cannot be toggled manually." });
        return;
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (checked !== undefined) {
      sets.push(`checked = $${i++}`);
      params.push(!!checked);
      if (checked) {
        sets.push(`checked_by = $${i++}`, `checked_at = NOW()`);
        params.push(req.user!.id);
      } else {
        sets.push(`checked_by = NULL`, `checked_at = NULL`);
      }
    }
    if (notes !== undefined) { sets.push(`notes = $${i++}`); params.push(notes); }
    if (label !== undefined) { sets.push(`label = $${i++}`); params.push(label); }
    if (required !== undefined) { sets.push(`required = $${i++}`); params.push(!!required); }

    if (sets.length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    params.push(req.params.itemId, req.params.releaseId);
    await tenantQuery(
      req.user!.orgId,
      `UPDATE release_checklist_items SET ${sets.join(", ")}
         WHERE id = $${i++} AND release_id = $${i}`,
      params
    );
    res.json({ updated: true });
  } catch (err) {
    console.error("PATCH checklist item error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /releases/:releaseId/items/:itemId
router.delete("/:releaseId/items/:itemId", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    await tenantQuery(
      req.user!.orgId,
      "DELETE FROM release_checklist_items WHERE id = $1 AND release_id = $2",
      [req.params.itemId, req.params.releaseId]
    );
    res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE checklist item error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /releases/:id
router.delete("/:id", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    await tenantQuery(req.user!.orgId, "DELETE FROM releases WHERE id = $1", [req.params.id]);
    await logAudit(req.user!.orgId, req.user!.id, "release.delete", "release", req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE /releases/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Jira version matching ───────────────────────────────────────────────

// GET /releases/:id/jira — match (or use cached match) and return the Jira
// version plus issue counts and the top open issues. Designed to be called
// from the release detail page; tolerates "not configured" and "no match"
// cases gracefully so the UI can render a prompt instead of an error.
router.get("/:id/jira", async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const releaseId = Number(req.params.id);

    const cfg = await getJiraConfig(orgId);
    if (!cfg) {
      res.json({ configured: false });
      return;
    }

    const rel = await tenantQuery(
      orgId,
      "SELECT id, version, jira_version_id, jira_version_name FROM releases WHERE id = $1",
      [releaseId]
    );
    if (rel.rows.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const row = rel.rows[0];

    // Use the pinned version if present, otherwise try to auto-match by the
    // release's version string. Cache the match on success.
    let matched: JiraVersion | null = null;
    try {
      if (row.jira_version_id) {
        const all = await fetchProjectVersions(cfg);
        matched = all.find((v) => v.id === row.jira_version_id) ?? null;
      }
      if (!matched) {
        matched = await findVersionByName(cfg, row.version);
        if (matched) {
          await tenantQuery(
            orgId,
            "UPDATE releases SET jira_version_id = $1, jira_version_name = $2, updated_at = NOW() WHERE id = $3",
            [matched.id, matched.name, releaseId]
          );
        }
      }
    } catch (err) {
      // Jira reachable but returned an error (bad creds, project not found,
      // etc.) — surface the error so the UI can nudge the user to settings.
      res.json({ configured: true, error: (err as Error).message });
      return;
    }

    if (!matched) {
      // No match — return the project's version list so the UI can offer a
      // manual pin. Capped to a reasonable number.
      let available: JiraVersion[] = [];
      try {
        available = (await fetchProjectVersions(cfg)).slice(-50).reverse();
      } catch {
        /* ignore */
      }
      res.json({
        configured: true,
        matched: false,
        release_version: row.version,
        available_versions: available,
      });
      return;
    }

    let counts = null;
    let issues: unknown[] = [];
    try {
      counts = await fetchVersionIssueCounts(cfg, matched.id);
    } catch (err) {
      console.error("Jira issue counts failed:", (err as Error).message);
    }
    try {
      issues = await fetchIssuesForVersion(cfg, matched.name, 25);
    } catch (err) {
      console.error("Jira issue search failed:", (err as Error).message);
    }

    const browseUrl = `${cfg.baseUrl}/projects/${encodeURIComponent(cfg.projectKey)}/versions/${encodeURIComponent(matched.id)}`;
    res.json({
      configured: true,
      matched: true,
      project_key: cfg.projectKey,
      version: matched,
      browse_url: browseUrl,
      counts,
      issues,
    });
  } catch (err) {
    console.error("GET /releases/:id/jira error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /releases/:id/jira/match — manually pin a specific Jira version
router.post("/:id/jira/match", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { version_id, version_name } = req.body ?? {};
    if (!version_id || !version_name) {
      res.status(400).json({ error: "version_id and version_name required" });
      return;
    }
    await tenantQuery(
      req.user!.orgId,
      "UPDATE releases SET jira_version_id = $1, jira_version_name = $2, updated_at = NOW() WHERE id = $3",
      [String(version_id), String(version_name), req.params.id]
    );
    await logAudit(req.user!.orgId, req.user!.id, "release.jira_match", "release", req.params.id, { version_id });
    res.json({ matched: true });
  } catch (err) {
    console.error("POST /releases/:id/jira/match error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /releases/:id/jira/match — clear the pinned version
router.delete("/:id/jira/match", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    await tenantQuery(
      req.user!.orgId,
      "UPDATE releases SET jira_version_id = NULL, jira_version_name = NULL, updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );
    await logAudit(req.user!.orgId, req.user!.id, "release.jira_unmatch", "release", req.params.id);
    res.json({ cleared: true });
  } catch (err) {
    console.error("DELETE /releases/:id/jira/match error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Linked runs ─────────────────────────────────────────────────────────

// POST /releases/:id/runs — body: { run_id }
router.post("/:id/runs", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const runId = Number(req.body?.run_id);
    if (!Number.isInteger(runId)) {
      res.status(400).json({ error: "run_id required" });
      return;
    }
    // Tenant-scope check — RLS guarantees we only see our own runs, so a
    // missing row means "not our run" or "doesn't exist".
    const exists = await tenantQuery(
      req.user!.orgId,
      "SELECT 1 FROM runs WHERE id = $1",
      [runId]
    );
    if (exists.rows.length === 0) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    await tenantQuery(
      req.user!.orgId,
      `INSERT INTO release_runs (release_id, run_id, org_id, added_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (release_id, run_id) DO NOTHING`,
      [req.params.id, runId, req.user!.orgId, req.user!.id]
    );
    await logAudit(req.user!.orgId, req.user!.id, "release.link_run", "release", req.params.id, { run_id: runId });
    res.json({ linked: true });
  } catch (err) {
    console.error("POST /releases/:id/runs error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /releases/:id/runs/:runId
router.delete("/:id/runs/:runId", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    await tenantQuery(
      req.user!.orgId,
      "DELETE FROM release_runs WHERE release_id = $1 AND run_id = $2",
      [req.params.id, req.params.runId]
    );
    await logAudit(req.user!.orgId, req.user!.id, "release.unlink_run", "release", req.params.id, { run_id: req.params.runId });
    res.json({ unlinked: true });
  } catch (err) {
    console.error("DELETE /releases/:id/runs/:runId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Linked manual tests ─────────────────────────────────────────────────

// POST /releases/:id/manual-tests — body: { manual_test_id } or { manual_test_ids: [...] }
router.post("/:id/manual-tests", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const ids: number[] = Array.isArray(req.body?.manual_test_ids)
      ? req.body.manual_test_ids.map(Number).filter((n: number) => Number.isInteger(n))
      : Number.isInteger(Number(req.body?.manual_test_id))
        ? [Number(req.body.manual_test_id)]
        : [];
    if (ids.length === 0) {
      res.status(400).json({ error: "manual_test_id(s) required" });
      return;
    }
    let linked = 0;
    for (const mtId of ids) {
      const exists = await tenantQuery(
        req.user!.orgId,
        "SELECT 1 FROM manual_tests WHERE id = $1",
        [mtId]
      );
      if (exists.rows.length === 0) continue;
      await tenantQuery(
        req.user!.orgId,
        `INSERT INTO release_manual_tests (release_id, manual_test_id, org_id, added_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (release_id, manual_test_id) DO NOTHING`,
        [req.params.id, mtId, req.user!.orgId, req.user!.id]
      );
      linked++;
    }
    await logAudit(req.user!.orgId, req.user!.id, "release.link_manual_tests", "release", req.params.id, { count: linked });
    res.json({ linked });
  } catch (err) {
    console.error("POST /releases/:id/manual-tests error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /releases/:id/manual-tests/:mtId
router.delete("/:id/manual-tests/:mtId", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    await tenantQuery(
      req.user!.orgId,
      "DELETE FROM release_manual_tests WHERE release_id = $1 AND manual_test_id = $2",
      [req.params.id, req.params.mtId]
    );
    await logAudit(req.user!.orgId, req.user!.id, "release.unlink_manual_test", "release", req.params.id, { manual_test_id: req.params.mtId });
    res.json({ unlinked: true });
  } catch (err) {
    console.error("DELETE /releases/:id/manual-tests/:mtId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
