import pool from "../db.js";
import { tenantQuery } from "../db.js";
import type { NormalizedRun } from "../types.js";

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
  issueType: string;
  autoCreate: boolean;
}

export interface JiraIssueResult {
  key: string;
  url: string;
}

async function getJiraConfig(orgId: number): Promise<JiraConfig | null> {
  const result = await pool.query(
    `SELECT jira_base_url, jira_email, jira_api_token, jira_project_key,
            jira_issue_type, jira_auto_create
     FROM organizations WHERE id = $1`,
    [orgId]
  );
  const row = result.rows[0];
  if (!row?.jira_base_url || !row?.jira_email || !row?.jira_api_token || !row?.jira_project_key) {
    return null;
  }
  return {
    baseUrl: row.jira_base_url.replace(/\/+$/, ""),
    email: row.jira_email,
    apiToken: row.jira_api_token,
    projectKey: row.jira_project_key,
    issueType: row.jira_issue_type ?? "Bug",
    autoCreate: !!row.jira_auto_create,
  };
}

function authHeader(cfg: JiraConfig): string {
  return "Basic " + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString("base64");
}

/**
 * Create a Jira issue. Throws on HTTP errors.
 */
export async function createJiraIssue(
  cfg: JiraConfig,
  summary: string,
  description: string
): Promise<JiraIssueResult> {
  const res = await fetch(`${cfg.baseUrl}/rest/api/2/issue`, {
    method: "POST",
    headers: {
      Authorization: authHeader(cfg),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      fields: {
        project: { key: cfg.projectKey },
        summary: summary.slice(0, 250),
        description,
        issuetype: { name: cfg.issueType },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Jira create failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { key: string };
  return { key: data.key, url: `${cfg.baseUrl}/browse/${data.key}` };
}

/**
 * Create a Jira issue for a failing test, deduped by fingerprint.
 * Returns the issue key/url (existing or newly created) or null if not configured.
 */
export async function createIssueForFingerprint(
  orgId: number,
  userId: number | null,
  fingerprint: string,
  summary: string,
  description: string
): Promise<JiraIssueResult | null> {
  const cfg = await getJiraConfig(orgId);
  if (!cfg) return null;

  const existing = await tenantQuery(
    orgId,
    "SELECT issue_key, issue_url FROM failure_jira_issues WHERE org_id = $1 AND fingerprint = $2",
    [orgId, fingerprint]
  );
  if (existing.rows.length > 0) {
    return { key: existing.rows[0].issue_key, url: existing.rows[0].issue_url };
  }

  const issue = await createJiraIssue(cfg, summary, description);

  await tenantQuery(
    orgId,
    `INSERT INTO failure_jira_issues (org_id, fingerprint, issue_key, issue_url, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, fingerprint) DO NOTHING`,
    [orgId, fingerprint, issue.key, issue.url, userId]
  );

  return issue;
}

/**
 * Auto-create issues for new failing tests in a completed run. No-op if not
 * enabled. Errors are swallowed so upload flow isn't affected.
 */
export async function autoCreateIssuesForRun(
  orgId: number,
  runId: number,
  run: NormalizedRun
): Promise<void> {
  try {
    const cfg = await getJiraConfig(orgId);
    if (!cfg || !cfg.autoCreate) return;
    if (run.stats.failed === 0) return;

    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:7777";

    const failed = run.specs.flatMap((spec) =>
      spec.tests
        .filter((t) => t.status === "failed")
        .map((t) => ({ spec, test: t }))
    );

    for (const { spec, test } of failed.slice(0, 20)) {
      const fingerprint = hashString(`${spec.file_path}::${test.full_title}`);
      const summary = `[${run.meta.suite_name}] ${test.full_title}`;
      const description = [
        `*Suite:* ${run.meta.suite_name}`,
        `*Branch:* ${run.meta.branch}`,
        `*Commit:* ${run.meta.commit_sha}`,
        `*Spec:* ${spec.file_path}`,
        ``,
        `*Error:*`,
        `{code}`,
        test.error?.message ?? "(no message)",
        `{code}`,
        ``,
        `Run: ${frontendUrl}/runs/${runId}`,
      ].join("\n");

      try {
        await createIssueForFingerprint(orgId, null, fingerprint, summary, description);
      } catch (err) {
        console.error("Jira auto-create failed:", (err as Error).message);
      }
    }
  } catch (err) {
    console.error("autoCreateIssuesForRun error:", err);
  }
}

function hashString(s: string): string {
  // Tiny stable fingerprint (not cryptographic). Matches existing pattern
  // where error fingerprints are short strings.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return `jira-${(h >>> 0).toString(16)}`;
}
