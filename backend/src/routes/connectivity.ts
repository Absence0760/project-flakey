import { Router, type Request, type Response, type NextFunction } from "express";
import pool from "../db.js";
import { decryptSecret } from "../crypto.js";
import { safeLog } from "../log.js";

const router = Router();

// All connectivity probes are admin/owner-only — they read org secrets
// (git tokens), trigger outbound calls to integrations, and send
// transactional mail. Viewer/contributor roles shouldn't be able to
// fan out org-credentialled requests.
router.use((req: Request, res: Response, next: NextFunction) => {
  const role = req.user?.orgRole;
  if (role !== "owner" && role !== "admin") {
    res.status(403).json({ error: "Admin or owner role required" });
    return;
  }
  next();
});

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
    // The raw error can carry SQL state, query detail, and constraint names —
    // log it server-side, return a fixed string to the client.
    console.error("POST /connectivity/database error:", safeLog(err));
    res.json({
      ok: false,
      latency_ms: Date.now() - start,
      error: "Database connection failed",
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
    // The raw error can carry the SMTP hostname/port (e.g.
    // "getaddrinfo ENOTFOUND mail.internal.acme.com") — log it server-side,
    // return a fixed string to the client.
    console.error("POST /connectivity/email error:", safeLog(err));
    res.json({
      ok: false,
      error: "Email service unavailable",
    });
  }
});

// POST /connectivity/git — test git provider token and repo access
router.post("/git", async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    // organizations has no RLS — `WHERE id = $1` bound to req.user!.orgId
    // is the sole tenant boundary. Router-level admin/owner check above
    // narrows callers further. Kept on pool.query (not tenantQuery)
    // because there's no RLS gate to set up; same pattern as auth.ts.
    const result = await pool.query(
      "SELECT git_provider, git_token, git_repo, git_base_url FROM organizations WHERE id = $1",
      [orgId]
    );
    const row = result.rows[0];
    if (!row?.git_provider || !row?.git_token || !row?.git_repo) {
      res.json({ ok: false, error: "Git provider not configured" });
      return;
    }

    // Decrypt git_token; fall back to raw value for legacy unencrypted rows
    // (in-place migration: the next write via PATCH /orgs/:id/settings will
    // re-encrypt the token automatically).
    let decryptedToken: string;
    try {
      decryptedToken = decryptSecret(row.git_token) ?? row.git_token;
    } catch {
      decryptedToken = row.git_token;
    }
    const { platform, token, repo, baseUrl } = {
      platform: row.git_provider,
      token: decryptedToken,
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
      // Read + log the upstream body server-side for diagnosis, but never echo
      // it to the client — it can leak repo slugs, branch names, and other
      // upstream-account detail. The status alone is safe to surface.
      const body = await response.text().catch(() => "");
      console.error(
        `POST /connectivity/git upstream ${platform} HTTP ${response.status}:`,
        safeLog(body)
      );
      res.json({
        ok: false,
        platform,
        status: response.status,
        error: response.status === 401 ? "Invalid token" :
               response.status === 403 ? "Token lacks required permissions" :
               response.status === 404 ? "Repository not found" :
               `Git provider returned HTTP ${response.status}`,
      });
    }
  } catch (err) {
    // The raw error can carry the resolved API host / token-bearing request
    // detail — log it server-side, return a fixed string to the client.
    console.error("POST /connectivity/git error:", safeLog(err));
    res.json({
      ok: false,
      error: "Git provider connection failed",
    });
  }
});

export default router;
