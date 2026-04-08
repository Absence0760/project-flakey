import { Router } from "express";
import pool from "../db.js";

const router = Router();

// POST /connectivity/database — test database connection
router.post("/database", async (_req, res) => {
  const start = Date.now();
  try {
    const result = await pool.query("SELECT version(), current_database(), current_user, pg_database_size(current_database()) AS db_size");
    const row = result.rows[0];
    res.json({
      ok: true,
      latency_ms: Date.now() - start,
      version: row.version.split(" ").slice(0, 2).join(" "),
      database: row.current_database,
      user: row.current_user,
      size_mb: Math.round(Number(row.db_size) / 1024 / 1024),
    });
  } catch (err) {
    res.json({
      ok: false,
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : "Connection failed",
    });
  }
});

// POST /connectivity/email — send a test email
router.post("/email", async (req, res) => {
  try {
    const { sendVerificationEmail } = await import("../email.js");
    // Send a test to the current user's email
    const userEmail = req.user!.email;
    await sendVerificationEmail(userEmail, "test-connection-" + Date.now());
    res.json({ ok: true, sent_to: userEmail });
  } catch (err) {
    res.json({
      ok: false,
      error: err instanceof Error ? err.message : "Email send failed",
    });
  }
});

// POST /connectivity/git — test git provider token and repo access
router.post("/git", async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const result = await pool.query(
      "SELECT git_provider, git_token, git_repo, git_base_url FROM organizations WHERE id = $1",
      [orgId]
    );
    const row = result.rows[0];
    if (!row?.git_provider || !row?.git_token || !row?.git_repo) {
      res.json({ ok: false, error: "Git provider not configured" });
      return;
    }

    const { platform, token, repo, baseUrl } = {
      platform: row.git_provider,
      token: row.git_token,
      repo: row.git_repo,
      baseUrl: row.git_base_url,
    };

    let apiUrl: string;
    let fetchOpts: RequestInit;

    if (platform === "github") {
      const [owner, repoName] = repo.split("/");
      apiUrl = `${baseUrl ?? "https://api.github.com"}/repos/${owner}/${repoName}`;
      fetchOpts = {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      };
    } else if (platform === "gitlab") {
      const projectId = encodeURIComponent(repo);
      apiUrl = `${(baseUrl ?? "https://gitlab.com").replace(/\/+$/, "")}/api/v4/projects/${projectId}`;
      fetchOpts = {
        headers: { "PRIVATE-TOKEN": token },
      };
    } else {
      // Bitbucket
      apiUrl = `${(baseUrl ?? "https://api.bitbucket.org/2.0").replace(/\/+$/, "")}/repositories/${repo}`;
      fetchOpts = {
        headers: { Authorization: `Bearer ${token}` },
      };
    }

    const start = Date.now();
    const response = await fetch(apiUrl, fetchOpts);
    const latency = Date.now() - start;

    if (response.ok) {
      const data = await response.json() as Record<string, unknown>;
      const repoName = (data.full_name ?? data.name_with_namespace ?? data.name ?? repo) as string;
      res.json({ ok: true, platform, repo: repoName, latency_ms: latency });
    } else {
      const body = await response.text().catch(() => "");
      res.json({
        ok: false,
        platform,
        status: response.status,
        error: response.status === 401 ? "Invalid token" :
               response.status === 403 ? "Token lacks required permissions" :
               response.status === 404 ? "Repository not found" :
               `HTTP ${response.status}: ${body.slice(0, 200)}`,
      });
    }
  } catch (err) {
    res.json({
      ok: false,
      error: err instanceof Error ? err.message : "Connection failed",
    });
  }
});

export default router;
