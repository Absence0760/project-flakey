import { Router } from "express";
import pool, { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";
import { createIssueForFingerprint, createJiraIssue } from "../integrations/jira.js";

const router = Router();

// GET /jira/settings
router.get("/settings", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT jira_base_url, jira_email, jira_project_key, jira_issue_type,
              jira_auto_create,
              jira_api_token IS NOT NULL AS has_api_token
       FROM organizations WHERE id = $1`,
      [req.user!.orgId]
    );
    res.json(result.rows[0] ?? {});
  } catch (err) {
    console.error("GET /jira/settings error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /jira/settings
router.patch("/settings", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { base_url, email, api_token, project_key, issue_type, auto_create } = req.body;
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const push = (col: string, val: unknown) => { sets.push(`${col} = $${i++}`); params.push(val); };

    if (base_url !== undefined) push("jira_base_url", base_url || null);
    if (email !== undefined) push("jira_email", email || null);
    if (api_token !== undefined) push("jira_api_token", api_token || null);
    if (project_key !== undefined) push("jira_project_key", project_key || null);
    if (issue_type !== undefined) push("jira_issue_type", issue_type || "Bug");
    if (auto_create !== undefined) push("jira_auto_create", !!auto_create);

    if (sets.length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    params.push(req.user!.orgId);
    await pool.query(`UPDATE organizations SET ${sets.join(", ")} WHERE id = $${i}`, params);
    await logAudit(req.user!.orgId, req.user!.id, "jira.settings.update", "settings", "jira");
    res.json({ updated: true });
  } catch (err) {
    console.error("PATCH /jira/settings error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /jira/test — verify credentials by hitting /myself
router.post("/test", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT jira_base_url, jira_email, jira_api_token FROM organizations WHERE id = $1`,
      [req.user!.orgId]
    );
    const row = result.rows[0];
    if (!row?.jira_base_url || !row?.jira_email || !row?.jira_api_token) {
      res.status(400).json({ error: "Jira not configured" });
      return;
    }
    const auth = "Basic " + Buffer.from(`${row.jira_email}:${row.jira_api_token}`).toString("base64");
    const resp = await fetch(`${row.jira_base_url.replace(/\/+$/, "")}/rest/api/2/myself`, {
      headers: { Authorization: auth, Accept: "application/json" },
    });
    res.json({ ok: resp.ok, status: resp.status });
  } catch (err) {
    res.json({ ok: false, status: 0, error: (err as Error).message });
  }
});

// POST /jira/issues — manually create an issue (from a test failure)
router.post("/issues", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { summary, description, fingerprint } = req.body;
    if (!summary || !description) {
      res.status(400).json({ error: "summary and description are required" });
      return;
    }

    const cfg = await pool.query(
      `SELECT jira_base_url, jira_email, jira_api_token, jira_project_key, jira_issue_type
       FROM organizations WHERE id = $1`,
      [req.user!.orgId]
    );
    const row = cfg.rows[0];
    if (!row?.jira_base_url || !row?.jira_api_token || !row?.jira_project_key) {
      res.status(400).json({ error: "Jira not configured" });
      return;
    }

    if (fingerprint) {
      const issue = await createIssueForFingerprint(
        req.user!.orgId,
        req.user!.id,
        String(fingerprint),
        summary,
        description
      );
      if (issue) {
        await logAudit(req.user!.orgId, req.user!.id, "jira.issue.create", "jira_issue", issue.key, { fingerprint });
        res.json(issue);
        return;
      }
    }

    const issue = await createJiraIssue(
      {
        baseUrl: row.jira_base_url.replace(/\/+$/, ""),
        email: row.jira_email,
        apiToken: row.jira_api_token,
        projectKey: row.jira_project_key,
        issueType: row.jira_issue_type ?? "Bug",
        autoCreate: false,
      },
      summary,
      description
    );
    await logAudit(req.user!.orgId, req.user!.id, "jira.issue.create", "jira_issue", issue.key);
    res.json(issue);
  } catch (err) {
    console.error("POST /jira/issues error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /jira/issues — list tracked issues for the org
router.get("/issues", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT fingerprint, issue_key, issue_url, created_at
       FROM failure_jira_issues ORDER BY created_at DESC LIMIT 200`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /jira/issues error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
