import { Router } from "express";
import multer from "multer";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";
import {
  getJiraConfig,
  createJiraIssue,
  fetchProjectVersions,
  findVersionByName,
  fetchVersionIssueCounts,
  fetchIssuesForVersion,
  type JiraVersion,
} from "../integrations/jira.js";
import { getStorage } from "../storage.js";

const evidenceUpload = multer({
  dest: "uploads/tmp",
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB per attachment — plenty for screenshots
});

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

// A failing item surfaced in the readiness panel so the user can drill into
// what's blocking the release without leaving the page.
interface FailingItem {
  label: string;              // test title / manual-test title
  sublabel?: string;          // spec file / group / priority / status
  href?: string;              // full link (/runs/:id) for automated tests
  test_id?: number;           // manual-test id → scroll-to-row in active session
  status?: string;            // passed|failed|blocked|not_run — for styling
}

interface RuleResult {
  met: boolean;
  details: string;
  failing_items?: FailingItem[];
}

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
  // An aborted live run didn't finish — treat it as unresolved, not passing.
  // The stats in `runs` reflect only what was captured before the process died,
  // so a "0 failed" count there is not a meaningful signal.
  const runIds = rows.map((r) => Number(r.id));
  const aborted = await tenantQuery(
    orgId,
    `SELECT DISTINCT run_id FROM live_events
      WHERE run_id = ANY($1::int[]) AND event_type = 'run.aborted'`,
    [runIds]
  );
  if (aborted.rows.length > 0) {
    return {
      met: false,
      details: `${aborted.rows.length} linked run(s) aborted — rerun required`,
    };
  }

  const totalFailed = rows.reduce((sum, r) => sum + Number(r.failed ?? 0), 0);
  const totalTests  = rows.reduce((sum, r) => sum + Number(r.total  ?? 0), 0);
  const label = scope === "linked" ? `${rows.length} linked run(s)` : "latest run";
  if (totalFailed === 0) {
    return { met: true, details: `${totalTests} tests passing across ${label}` };
  }

  // Pull the actual failing test rows so the readiness panel can list
  // them by name and link straight into the run page. Capped to avoid
  // dumping hundreds of failures inline.
  const failingTests = await tenantQuery(
    orgId,
    `SELECT t.title, t.status, s.file_path, s.run_id
       FROM tests t
       JOIN specs s ON s.id = t.spec_id
      WHERE s.run_id = ANY($1::int[])
        AND t.status = 'failed'
      ORDER BY s.file_path, t.title
      LIMIT 50`,
    [runIds]
  );
  const failing_items: FailingItem[] = failingTests.rows.map((r) => ({
    label: r.title,
    sublabel: r.file_path,
    href: `/runs/${r.run_id}`,
    status: "failed",
  }));
  return {
    met: false,
    details: `${totalFailed} failing test(s) across ${label}`,
    failing_items,
  };
}

async function evaluateManualRegressionExecuted(
  orgId: number,
  releaseId: number
): Promise<RuleResult> {
  // Use the most-recent session (in-progress or completed) so readiness
  // tracks the active cycle in real time as results are recorded. Fall
  // back to flat release_manual_tests statuses only when no session
  // exists, then to org-wide high/critical priority tests.
  const latestSession = await tenantQuery(
    orgId,
    `SELECT id, session_number, label, status FROM release_test_sessions
      WHERE release_id = $1
      ORDER BY session_number DESC LIMIT 1`,
    [releaseId]
  );
  if (latestSession.rows.length > 0) {
    const session = latestSession.rows[0];
    const results = await tenantQuery(
      orgId,
      `SELECT r.status, r.accepted_as_known_issue, r.manual_test_id,
              mt.title, mt.priority, g.name AS group_name
         FROM release_test_session_results r
         JOIN manual_tests mt ON mt.id = r.manual_test_id
         LEFT JOIN manual_test_groups g ON g.id = mt.group_id
        WHERE r.session_id = $1
        ORDER BY mt.priority DESC, mt.title`,
      [session.id]
    );
    const rows = results.rows;
    if (rows.length === 0) {
      return { met: false, details: `Session #${session.session_number} has no tests` };
    }
    // Accepted failures/blocked are explicitly deferred against a bug — they
    // no longer count as blockers. Everything else must be in a clean state.
    const blockingFailedRows  = rows.filter((r) => r.status === "failed"  && !r.accepted_as_known_issue);
    const blockingBlockedRows = rows.filter((r) => r.status === "blocked" && !r.accepted_as_known_issue);
    const notRunRows          = rows.filter((r) => r.status === "not_run");
    const accepted            = rows.filter((r) => r.accepted_as_known_issue).length;
    const inProgress = session.status === "in_progress";
    const label = inProgress
      ? `session #${session.session_number} (in progress)`
      : `session #${session.session_number}`;

    const toItem = (r: { manual_test_id: number; title: string; priority: string; group_name: string | null; status: string }): FailingItem => ({
      label: r.title,
      sublabel: [r.group_name, r.priority].filter(Boolean).join(" · "),
      test_id: Number(r.manual_test_id),
      status: r.status,
    });

    if (blockingFailedRows.length > 0) {
      return {
        met: false,
        details: `${blockingFailedRows.length} failing test(s) in ${label}`,
        failing_items: blockingFailedRows.map(toItem),
      };
    }
    if (blockingBlockedRows.length > 0) {
      return {
        met: false,
        details: `${blockingBlockedRows.length} blocked test(s) in ${label}`,
        failing_items: blockingBlockedRows.map(toItem),
      };
    }
    if (notRunRows.length > 0) {
      return {
        met: false,
        details: `${notRunRows.length} of ${rows.length} test(s) not run in ${label}`,
        failing_items: notRunRows.map(toItem),
      };
    }
    // An in-progress session with no not_run/failed is effectively passing
    // but still in-progress — readiness should not turn green until the
    // session is completed (the acting tester is still expected to Mark
    // session complete). Keep it unmet to force that explicit action.
    if (inProgress) {
      return { met: false, details: `All tests executed in ${label} — mark session complete to pass` };
    }
    const suffix = accepted > 0 ? ` (${accepted} accepted as known issue)` : "";
    return { met: true, details: `${rows.length - accepted}/${rows.length} tests executed cleanly in ${label}${suffix}` };
  }

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

    // Prefer the most-recent session's result counts so the readiness card
    // updates live as testers record outcomes. Fall back to the flat
    // release_manual_tests statuses when no session has been started.
    const latestSessionId = await tenantQuery(
      orgId,
      `SELECT id FROM release_test_sessions
        WHERE release_id = $1
        ORDER BY session_number DESC LIMIT 1`,
      [releaseId]
    );
    let manualStats;
    if (latestSessionId.rows.length > 0) {
      manualStats = await tenantQuery(
        orgId,
        `SELECT COUNT(*)::int AS linked,
                COUNT(*) FILTER (WHERE status = 'passed')::int  AS passed,
                COUNT(*) FILTER (WHERE status = 'failed')::int  AS failed,
                COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked,
                COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
                COUNT(*) FILTER (WHERE status = 'not_run')::int AS not_run,
                COUNT(*) FILTER (WHERE accepted_as_known_issue = TRUE)::int AS accepted
           FROM release_test_session_results
          WHERE session_id = $1`,
        [latestSessionId.rows[0].id]
      );
    } else {
      manualStats = await tenantQuery(
        orgId,
        `SELECT COUNT(*)::int AS linked,
                COUNT(*) FILTER (WHERE mt.status = 'passed')::int  AS passed,
                COUNT(*) FILTER (WHERE mt.status = 'failed')::int  AS failed,
                COUNT(*) FILTER (WHERE mt.status = 'blocked')::int AS blocked,
                COUNT(*) FILTER (WHERE mt.status = 'skipped')::int AS skipped,
                COUNT(*) FILTER (WHERE mt.status = 'not_run')::int AS not_run,
                0::int AS accepted
           FROM release_manual_tests rmt
           JOIN manual_tests mt ON mt.id = rmt.manual_test_id
          WHERE rmt.release_id = $1`,
        [releaseId]
      );
    }

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
    if ((err as { code?: string })?.code === "23505") {
      res.status(409).json({ error: `A release with version "${req.body?.version}" already exists` });
      return;
    }
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

// POST /releases/:id/runs — body: { run_id } or { run_ids: [...] }
router.post("/:id/runs", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const ids: number[] = Array.isArray(req.body?.run_ids)
      ? req.body.run_ids.map(Number).filter((n: number) => Number.isInteger(n))
      : Number.isInteger(Number(req.body?.run_id))
        ? [Number(req.body.run_id)]
        : [];
    if (ids.length === 0) {
      res.status(400).json({ error: "run_id(s) required" });
      return;
    }
    // Tenant-scope check — RLS guarantees we only see our own runs, so a
    // missing row means "not our run" or "doesn't exist".
    let linked = 0;
    for (const runId of ids) {
      const exists = await tenantQuery(
        req.user!.orgId,
        "SELECT 1 FROM runs WHERE id = $1",
        [runId]
      );
      if (exists.rows.length === 0) continue;
      await tenantQuery(
        req.user!.orgId,
        `INSERT INTO release_runs (release_id, run_id, org_id, added_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (release_id, run_id) DO NOTHING`,
        [req.params.id, runId, req.user!.orgId, req.user!.id]
      );
      linked++;
    }
    await logAudit(req.user!.orgId, req.user!.id, "release.link_runs", "release", req.params.id, { count: linked });
    res.json({ linked });
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

// POST /releases/:id/manual-test-groups/:groupId — bulk-link every test in
// a group to the release. Skips tests already linked via ON CONFLICT.
router.post("/:id/manual-test-groups/:groupId", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const groupExists = await tenantQuery(
      req.user!.orgId,
      "SELECT 1 FROM manual_test_groups WHERE id = $1",
      [req.params.groupId]
    );
    if (groupExists.rows.length === 0) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const result = await tenantQuery(
      req.user!.orgId,
      `INSERT INTO release_manual_tests (release_id, manual_test_id, org_id, added_by)
       SELECT $1, mt.id, $2, $3
         FROM manual_tests mt
        WHERE mt.group_id = $4
       ON CONFLICT (release_id, manual_test_id) DO NOTHING
       RETURNING manual_test_id`,
      [req.params.id, req.user!.orgId, req.user!.id, req.params.groupId]
    );
    const countResult = await tenantQuery(
      req.user!.orgId,
      "SELECT COUNT(*)::int AS total FROM manual_tests WHERE group_id = $1",
      [req.params.groupId]
    );
    await logAudit(
      req.user!.orgId,
      req.user!.id,
      "release.link_manual_test_group",
      "release",
      req.params.id,
      { group_id: req.params.groupId, linked: result.rowCount }
    );
    res.json({
      linked: result.rowCount,
      total_in_group: countResult.rows[0].total,
    });
  } catch (err) {
    console.error("POST /releases/:id/manual-test-groups/:groupId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Release test sessions ───────────────────────────────────────────────

const SESSION_MODES = ["full", "failures_only"];
const SESSION_RESULT_STATUSES = ["not_run", "passed", "failed", "blocked", "skipped"];

// GET /releases/:id/sessions — all sessions with progress counts
router.get("/:id/sessions", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT s.id, s.session_number, s.label, s.mode, s.status,
              s.created_at, s.completed_at, s.target_date,
              u.email AS created_by_email,
              COALESCE(c.total, 0)::int    AS total,
              COALESCE(c.passed, 0)::int   AS passed,
              COALESCE(c.failed, 0)::int   AS failed,
              COALESCE(c.blocked, 0)::int  AS blocked,
              COALESCE(c.skipped, 0)::int  AS skipped,
              COALESCE(c.not_run, 0)::int  AS not_run,
              COALESCE(c.accepted, 0)::int AS accepted
         FROM release_test_sessions s
         LEFT JOIN users u ON u.id = s.created_by
         LEFT JOIN (
           SELECT session_id,
                  COUNT(*)                                                                   AS total,
                  COUNT(*) FILTER (WHERE status = 'passed')                                  AS passed,
                  COUNT(*) FILTER (WHERE status = 'failed')                                  AS failed,
                  COUNT(*) FILTER (WHERE status = 'blocked')                                 AS blocked,
                  COUNT(*) FILTER (WHERE status = 'skipped')                                 AS skipped,
                  COUNT(*) FILTER (WHERE status = 'not_run')                                 AS not_run,
                  COUNT(*) FILTER (WHERE accepted_as_known_issue = TRUE)                     AS accepted
             FROM release_test_session_results
            GROUP BY session_id
         ) c ON c.session_id = s.id
        WHERE s.release_id = $1
        ORDER BY s.session_number DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /releases/:id/sessions error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /releases/:id/sessions — create a new session
// Body: { label?, mode: 'full' | 'failures_only' }
router.post("/:id/sessions", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const releaseId = Number(req.params.id);
    const label: string | null = req.body?.label ?? null;
    const targetDate: string | null = req.body?.target_date ?? null;
    const mode: string = SESSION_MODES.includes(req.body?.mode) ? req.body.mode : "full";

    // Forbid parallel sessions: an in_progress one must be closed first.
    const active = await tenantQuery(
      req.user!.orgId,
      "SELECT id FROM release_test_sessions WHERE release_id = $1 AND status = 'in_progress'",
      [releaseId]
    );
    if (active.rows.length > 0) {
      res.status(409).json({ error: "An in-progress session already exists for this release" });
      return;
    }

    // Scope: all linked tests (full), or only failed/blocked from the most
    // recent session (failures_only). On first-ever failures_only request
    // with no prior session, fall back to linked tests.
    let scopeTestIds: number[] = [];
    if (mode === "failures_only") {
      const prev = await tenantQuery(
        req.user!.orgId,
        `SELECT id FROM release_test_sessions
          WHERE release_id = $1
          ORDER BY session_number DESC LIMIT 1`,
        [releaseId]
      );
      if (prev.rows.length > 0) {
        // Skip results explicitly deferred as known issues — they're in the
        // "we're shipping with this" bucket, not the "run again" bucket.
        const prevResults = await tenantQuery(
          req.user!.orgId,
          `SELECT manual_test_id FROM release_test_session_results
            WHERE session_id = $1
              AND status IN ('failed','blocked')
              AND accepted_as_known_issue = FALSE`,
          [prev.rows[0].id]
        );
        scopeTestIds = prevResults.rows.map((r) => Number(r.manual_test_id));
      }
    }
    if (mode === "full" || scopeTestIds.length === 0) {
      const linked = await tenantQuery(
        req.user!.orgId,
        "SELECT manual_test_id FROM release_manual_tests WHERE release_id = $1",
        [releaseId]
      );
      scopeTestIds = linked.rows.map((r) => Number(r.manual_test_id));
    }

    if (scopeTestIds.length === 0) {
      res.status(400).json({
        error: "No tests in scope. Link manual tests to the release before starting a session.",
      });
      return;
    }

    const nextNumberResult = await tenantQuery(
      req.user!.orgId,
      `SELECT COALESCE(MAX(session_number), 0) + 1 AS next
         FROM release_test_sessions WHERE release_id = $1`,
      [releaseId]
    );
    const sessionNumber = Number(nextNumberResult.rows[0].next);

    const session = await tenantQuery(
      req.user!.orgId,
      `INSERT INTO release_test_sessions
         (org_id, release_id, session_number, label, mode, created_by, target_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, session_number, label, mode, status, created_at, target_date`,
      [req.user!.orgId, releaseId, sessionNumber, label, mode, req.user!.id, targetDate]
    );
    const sessionId = session.rows[0].id;

    // Seed one not_run row per test in scope.
    for (const testId of scopeTestIds) {
      await tenantQuery(
        req.user!.orgId,
        `INSERT INTO release_test_session_results (org_id, session_id, manual_test_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (session_id, manual_test_id) DO NOTHING`,
        [req.user!.orgId, sessionId, testId]
      );
    }

    await logAudit(
      req.user!.orgId,
      req.user!.id,
      "release.session_create",
      "release",
      req.params.id,
      { session_id: sessionId, mode, seeded: scopeTestIds.length }
    );
    res.status(201).json({
      ...session.rows[0],
      seeded: scopeTestIds.length,
    });
  } catch (err: any) {
    // Unique-violation from the partial index (migration 031) means a concurrent
    // request beat us to creating the in_progress session. Treat as 409.
    if (err?.code === "23505") {
      res.status(409).json({ error: "An in-progress session already exists for this release" });
      return;
    }
    console.error("POST /releases/:id/sessions error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /releases/:id/sessions/:sessionId — session with all result rows
router.get("/:id/sessions/:sessionId", async (req, res) => {
  try {
    const session = await tenantQuery(
      req.user!.orgId,
      `SELECT s.id, s.release_id, s.session_number, s.label, s.mode, s.status,
              s.created_at, s.completed_at, s.target_date,
              u.email AS created_by_email
         FROM release_test_sessions s
         LEFT JOIN users u ON u.id = s.created_by
        WHERE s.id = $1 AND s.release_id = $2`,
      [req.params.sessionId, req.params.id]
    );
    if (session.rows.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const results = await tenantQuery(
      req.user!.orgId,
      `SELECT r.id, r.manual_test_id, r.status, r.notes, r.step_results,
              r.run_at, u.email AS run_by_email,
              r.accepted_as_known_issue, r.known_issue_ref,
              r.accepted_at, au.email AS accepted_by_email,
              r.filed_bug_key, r.filed_bug_url,
              r.attachments,
              r.assigned_to, asg.email AS assigned_to_email,
              mt.title, mt.suite_name, mt.priority,
              mt.group_id, g.name AS group_name
         FROM release_test_session_results r
         JOIN manual_tests mt ON mt.id = r.manual_test_id
         LEFT JOIN manual_test_groups g ON g.id = mt.group_id
         LEFT JOIN users u ON u.id = r.run_by
         LEFT JOIN users au ON au.id = r.accepted_by
         LEFT JOIN users asg ON asg.id = r.assigned_to
        WHERE r.session_id = $1
        ORDER BY mt.priority DESC, mt.title`,
      [req.params.sessionId]
    );
    res.json({ ...session.rows[0], results: results.rows });
  } catch (err) {
    console.error("GET /releases/:id/sessions/:sessionId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /releases/:id/sessions/:sessionId — update label or mark completed
router.patch("/:id/sessions/:sessionId", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (req.body.label !== undefined) {
      sets.push(`label = $${i++}`);
      params.push(req.body.label);
    }
    if (req.body.target_date !== undefined) {
      sets.push(`target_date = $${i++}`);
      params.push(req.body.target_date);
    }
    if (req.body.status !== undefined) {
      if (req.body.status !== "in_progress" && req.body.status !== "completed") {
        res.status(400).json({ error: "Invalid status" });
        return;
      }
      sets.push(`status = $${i++}`);
      params.push(req.body.status);
      if (req.body.status === "completed") {
        sets.push("completed_at = NOW()");
      } else {
        sets.push("completed_at = NULL");
      }
    }
    if (sets.length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    params.push(req.params.sessionId, req.params.id);
    await tenantQuery(
      req.user!.orgId,
      `UPDATE release_test_sessions SET ${sets.join(", ")}
        WHERE id = $${i++} AND release_id = $${i}`,
      params
    );
    await logAudit(
      req.user!.orgId,
      req.user!.id,
      "release.session_update",
      "release",
      req.params.id,
      { session_id: req.params.sessionId }
    );
    res.json({ updated: true });
  } catch (err) {
    console.error("PATCH /releases/:id/sessions/:sessionId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /releases/:id/sessions/:sessionId/results/:testId — record a result
// Body: { status, notes?, step_results? }
// Auto-completes the session when every result row is in a terminal state.
router.post("/:id/sessions/:sessionId/results/:testId", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { status, notes, step_results } = req.body;
    if (!SESSION_RESULT_STATUSES.includes(status) || status === "not_run") {
      res.status(400).json({ error: "Invalid status" });
      return;
    }
    let normalizedSteps: Array<{ status: string; comment: string }> = [];
    if (step_results !== undefined) {
      if (!Array.isArray(step_results)) {
        res.status(400).json({ error: "step_results must be an array" });
        return;
      }
      for (const r of step_results) {
        if (!r || typeof r.status !== "string") {
          res.status(400).json({ error: "Invalid step result" });
          return;
        }
        normalizedSteps.push({
          status: r.status,
          comment: typeof r.comment === "string" ? r.comment : "",
        });
      }
    }

    const session = await tenantQuery(
      req.user!.orgId,
      `SELECT id, status FROM release_test_sessions
        WHERE id = $1 AND release_id = $2`,
      [req.params.sessionId, req.params.id]
    );
    if (session.rows.length === 0) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (session.rows[0].status === "completed") {
      res.status(409).json({ error: "Session is already completed" });
      return;
    }

    const updated = await tenantQuery(
      req.user!.orgId,
      `UPDATE release_test_session_results
          SET status = $1,
              notes = $2,
              step_results = $3::jsonb,
              run_by = $4,
              run_at = NOW()
        WHERE session_id = $5 AND manual_test_id = $6
        RETURNING id`,
      [
        status,
        notes ?? null,
        JSON.stringify(normalizedSteps),
        req.user!.id,
        req.params.sessionId,
        req.params.testId,
      ]
    );
    if (updated.rows.length === 0) {
      res.status(404).json({ error: "Test not in session scope" });
      return;
    }

    // Auto-complete when every row is in a terminal (non-not_run) state.
    const remaining = await tenantQuery(
      req.user!.orgId,
      `SELECT COUNT(*)::int AS c FROM release_test_session_results
        WHERE session_id = $1 AND status = 'not_run'`,
      [req.params.sessionId]
    );
    let sessionCompleted = false;
    if (remaining.rows[0].c === 0) {
      await tenantQuery(
        req.user!.orgId,
        `UPDATE release_test_sessions
            SET status = 'completed', completed_at = NOW()
          WHERE id = $1`,
        [req.params.sessionId]
      );
      sessionCompleted = true;
    }

    await logAudit(
      req.user!.orgId,
      req.user!.id,
      "release.session_result",
      "release",
      req.params.id,
      { session_id: req.params.sessionId, manual_test_id: req.params.testId, status }
    );
    res.json({ updated: true, session_completed: sessionCompleted });
  } catch (err) {
    console.error("POST /releases/:id/sessions/:sessionId/results/:testId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /releases/:id/sessions/:sessionId/results/:testId/accept
// Defer a failed/blocked result as a known issue for this release so it
// stops counting as a blocker and drops out of failures-only reruns.
// Body: { known_issue_ref?: string }
router.post("/:id/sessions/:sessionId/results/:testId/accept", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { known_issue_ref } = req.body ?? {};

    const existing = await tenantQuery(
      req.user!.orgId,
      `SELECT r.id, r.status
         FROM release_test_session_results r
         JOIN release_test_sessions s ON s.id = r.session_id
        WHERE r.session_id = $1 AND r.manual_test_id = $2 AND s.release_id = $3`,
      [req.params.sessionId, req.params.testId, req.params.id]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Result not found" });
      return;
    }
    // Only failures and blocked can be deferred. Passing/skipped/not_run
    // acceptance makes no sense and would hide real problems.
    if (!["failed", "blocked"].includes(existing.rows[0].status)) {
      res.status(400).json({ error: "Only failed or blocked results can be accepted as known issues" });
      return;
    }

    await tenantQuery(
      req.user!.orgId,
      `UPDATE release_test_session_results
          SET accepted_as_known_issue = TRUE,
              known_issue_ref = $1,
              accepted_by = $2,
              accepted_at = NOW()
        WHERE session_id = $3 AND manual_test_id = $4`,
      [known_issue_ref ?? null, req.user!.id, req.params.sessionId, req.params.testId]
    );
    await logAudit(
      req.user!.orgId,
      req.user!.id,
      "release.session_result_accept",
      "release",
      req.params.id,
      { session_id: req.params.sessionId, manual_test_id: req.params.testId, known_issue_ref }
    );
    res.json({ accepted: true });
  } catch (err) {
    console.error("POST accept known-issue error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /releases/:id/sessions/:sessionId/results/:testId/file-bug
// Create a bug in the configured tracker (Jira today) pre-filled from the
// test data, and record the issue key/url on the session result. If the
// user passed `mark_known_issue: true`, also flip accepted_as_known_issue
// so the release can ship. Currently only Jira — other providers in time.
router.post("/:id/sessions/:sessionId/results/:testId/file-bug", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const cfg = await getJiraConfig(req.user!.orgId);
    if (!cfg) {
      res.status(400).json({ error: "Jira is not configured for this org" });
      return;
    }

    const existing = await tenantQuery(
      req.user!.orgId,
      `SELECT r.id, r.status, r.notes, r.filed_bug_key, r.filed_bug_url,
              mt.title, mt.suite_name, mt.description, mt.steps
         FROM release_test_session_results r
         JOIN manual_tests mt ON mt.id = r.manual_test_id
         JOIN release_test_sessions s ON s.id = r.session_id
        WHERE r.session_id = $1 AND r.manual_test_id = $2 AND s.release_id = $3`,
      [req.params.sessionId, req.params.testId, req.params.id]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Result not found" });
      return;
    }
    const row = existing.rows[0];
    if (row.filed_bug_key) {
      res.json({ key: row.filed_bug_key, url: row.filed_bug_url, already_filed: true });
      return;
    }

    // Compose a useful issue body. Keep the title under Jira's 250-char cap.
    const summary = `[Manual test failure] ${row.title}`;
    const steps = Array.isArray(row.steps) ? row.steps : [];
    const stepsText = steps.length
      ? steps.map((s: unknown, i: number) => {
          const obj = s as { action?: string; data?: string; expected?: string };
          const parts = [
            obj.action ? obj.action : "",
            obj.data ? `(data: ${obj.data})` : "",
            obj.expected ? `→ ${obj.expected}` : "",
          ].filter(Boolean);
          return `${i + 1}. ${parts.join(" ")}`;
        }).join("\n")
      : "(no steps recorded)";
    const release = await tenantQuery(
      req.user!.orgId,
      "SELECT version, name FROM releases WHERE id = $1",
      [req.params.id]
    );
    const relLabel = release.rows[0]
      ? `${release.rows[0].version}${release.rows[0].name ? ` (${release.rows[0].name})` : ""}`
      : `release #${req.params.id}`;
    const description = [
      `*Manual test failed during release testing of ${relLabel}.*`,
      ``,
      `*Test:* ${row.title}`,
      row.suite_name ? `*Suite:* ${row.suite_name}` : "",
      ``,
      `*Steps:*`,
      stepsText,
      ``,
      `*Recorded status:* ${row.status}`,
      row.notes ? `*Tester notes:*\n${row.notes}` : "",
    ].filter(Boolean).join("\n");

    const issue = await createJiraIssue(cfg, summary, description);

    // Persist the issue on the result. If requested, also mark as accepted.
    const markKnown = req.body?.mark_known_issue === true;
    await tenantQuery(
      req.user!.orgId,
      `UPDATE release_test_session_results
          SET filed_bug_key = $1,
              filed_bug_url = $2,
              known_issue_ref = COALESCE(known_issue_ref, $2),
              accepted_as_known_issue = CASE WHEN $3 THEN TRUE ELSE accepted_as_known_issue END,
              accepted_by = CASE WHEN $3 AND accepted_by IS NULL THEN $4 ELSE accepted_by END,
              accepted_at = CASE WHEN $3 AND accepted_at IS NULL THEN NOW() ELSE accepted_at END
        WHERE session_id = $5 AND manual_test_id = $6`,
      [issue.key, issue.url, markKnown, req.user!.id, req.params.sessionId, req.params.testId]
    );
    await logAudit(
      req.user!.orgId,
      req.user!.id,
      "release.session_result_file_bug",
      "release",
      req.params.id,
      { session_id: req.params.sessionId, manual_test_id: req.params.testId, issue: issue.key, mark_known_issue: markKnown }
    );
    res.json({ key: issue.key, url: issue.url, already_filed: false });
  } catch (err) {
    console.error("POST file-bug error:", err);
    res.status(500).json({ error: (err as Error).message ?? "Internal server error" });
  }
});

// POST /releases/:id/sessions/:sessionId/results/:testId/assign
// Body: { user_id: number | null } — assign (or un-assign) a tester to a
// specific test-in-session. Scoped to the user's org via RLS.
router.post("/:id/sessions/:sessionId/results/:testId/assign", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const userId = req.body?.user_id;
    const normalised = userId === null || userId === undefined
      ? null
      : Number.isInteger(Number(userId)) ? Number(userId) : null;

    await tenantQuery(
      req.user!.orgId,
      `UPDATE release_test_session_results r
          SET assigned_to = $1
         FROM release_test_sessions s
        WHERE r.session_id = s.id
          AND r.session_id = $2
          AND r.manual_test_id = $3
          AND s.release_id = $4`,
      [normalised, req.params.sessionId, req.params.testId, req.params.id]
    );
    await logAudit(
      req.user!.orgId,
      req.user!.id,
      "release.session_result_assign",
      "release",
      req.params.id,
      { session_id: req.params.sessionId, manual_test_id: req.params.testId, user_id: normalised }
    );
    res.json({ assigned: true, user_id: normalised });
  } catch (err) {
    console.error("POST assign error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /releases/:id/sessions/:sessionId/results/:testId/evidence
// Multipart upload — accepts multiple `files` fields. Each goes to the
// configured storage backend; the JSONB column holds metadata only.
router.post(
  "/:id/sessions/:sessionId/results/:testId/evidence",
  evidenceUpload.array("files", 20),
  async (req, res) => {
    try {
      if (req.user!.orgRole === "viewer") {
        res.status(403).json({ error: "Admin role required" });
        return;
      }
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        res.status(400).json({ error: "No files uploaded" });
        return;
      }

      const existing = await tenantQuery(
        req.user!.orgId,
        `SELECT r.id
           FROM release_test_session_results r
           JOIN release_test_sessions s ON s.id = r.session_id
          WHERE r.session_id = $1 AND r.manual_test_id = $2 AND s.release_id = $3`,
        [req.params.sessionId, req.params.testId, req.params.id]
      );
      if (existing.rows.length === 0) {
        res.status(404).json({ error: "Result not found" });
        return;
      }

      const storage = getStorage();
      const added: Array<{ key: string; url: string; filename: string; size: number; uploaded_by: number; uploaded_at: string }> = [];
      for (const f of files) {
        const ts = Date.now();
        const safeName = f.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
        const key = `evidence/${req.params.sessionId}/${req.params.testId}/${ts}-${safeName}`;
        await storage.put(f.path, key);
        const url = await storage.getUrl(key);
        added.push({
          key,
          url,
          filename: f.originalname,
          size: f.size,
          uploaded_by: req.user!.id,
          uploaded_at: new Date().toISOString(),
        });
      }

      await tenantQuery(
        req.user!.orgId,
        `UPDATE release_test_session_results
            SET attachments = attachments || $1::jsonb
          WHERE session_id = $2 AND manual_test_id = $3`,
        [JSON.stringify(added), req.params.sessionId, req.params.testId]
      );
      await logAudit(
        req.user!.orgId,
        req.user!.id,
        "release.session_result_evidence",
        "release",
        req.params.id,
        { session_id: req.params.sessionId, manual_test_id: req.params.testId, files: added.length }
      );
      res.json({ added });
    } catch (err) {
      console.error("POST evidence error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// DELETE .../evidence — body: { key: string } removes the matching
// attachment entry. The underlying storage object is left in place so
// deletions can't lose audit evidence; reap via retention instead.
router.delete("/:id/sessions/:sessionId/results/:testId/evidence", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { key } = req.body ?? {};
    if (!key) {
      res.status(400).json({ error: "key required" });
      return;
    }
    await tenantQuery(
      req.user!.orgId,
      `UPDATE release_test_session_results r
          SET attachments = (
            SELECT COALESCE(jsonb_agg(a), '[]'::jsonb)
              FROM jsonb_array_elements(r.attachments) a
             WHERE a->>'key' <> $1
          )
         FROM release_test_sessions s
        WHERE r.session_id = s.id
          AND r.session_id = $2
          AND r.manual_test_id = $3
          AND s.release_id = $4`,
      [key, req.params.sessionId, req.params.testId, req.params.id]
    );
    res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE evidence error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /releases/:id/requirements — coverage rollup. Groups linked manual
// tests by each of their requirements and reports pass/fail counts against
// the most recent session so the release page can show "Story ABC-42 →
// 3 tests, 2 passing".
router.get("/:id/requirements", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `WITH latest_session AS (
         SELECT id FROM release_test_sessions
          WHERE release_id = $1
          ORDER BY session_number DESC LIMIT 1
       ),
       latest_results AS (
         SELECT r.manual_test_id, r.status
           FROM release_test_session_results r
          WHERE r.session_id = (SELECT id FROM latest_session)
       ),
       test_status AS (
         SELECT mt.id AS manual_test_id,
                COALESCE(lr.status, mt.status) AS effective_status,
                mt.title, mt.priority
           FROM manual_tests mt
           JOIN release_manual_tests rmt ON rmt.manual_test_id = mt.id
           LEFT JOIN latest_results lr ON lr.manual_test_id = mt.id
          WHERE rmt.release_id = $1
       )
       SELECT req.ref_key, req.ref_url, req.ref_title, req.provider,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE ts.effective_status = 'passed')::int  AS passed,
              COUNT(*) FILTER (WHERE ts.effective_status = 'failed')::int  AS failed,
              COUNT(*) FILTER (WHERE ts.effective_status = 'blocked')::int AS blocked,
              COUNT(*) FILTER (WHERE ts.effective_status = 'not_run')::int AS not_run,
              jsonb_agg(jsonb_build_object(
                'id', ts.manual_test_id,
                'title', ts.title,
                'priority', ts.priority,
                'status', ts.effective_status
              ) ORDER BY ts.title) AS tests
         FROM manual_test_requirements req
         JOIN test_status ts ON ts.manual_test_id = req.manual_test_id
        GROUP BY req.ref_key, req.ref_url, req.ref_title, req.provider
        ORDER BY req.ref_key`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET requirements coverage error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE .../accept — revoke a prior acceptance so the result blocks again.
router.delete("/:id/sessions/:sessionId/results/:testId/accept", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    await tenantQuery(
      req.user!.orgId,
      `UPDATE release_test_session_results r
          SET accepted_as_known_issue = FALSE,
              known_issue_ref = NULL,
              accepted_by = NULL,
              accepted_at = NULL
         FROM release_test_sessions s
        WHERE r.session_id = s.id
          AND r.session_id = $1
          AND r.manual_test_id = $2
          AND s.release_id = $3`,
      [req.params.sessionId, req.params.testId, req.params.id]
    );
    await logAudit(
      req.user!.orgId,
      req.user!.id,
      "release.session_result_unaccept",
      "release",
      req.params.id,
      { session_id: req.params.sessionId, manual_test_id: req.params.testId }
    );
    res.json({ unaccepted: true });
  } catch (err) {
    console.error("DELETE accept known-issue error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
