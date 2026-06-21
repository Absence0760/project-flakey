import { createHash } from "crypto";
import pool from "../db.js";
import { tenantQuery } from "../db.js";
import { decryptSecret } from "../crypto.js";
import { safeLog } from "../log.js";
import type { NormalizedRun, NormalizedSpec, NormalizedTest } from "../types.js";

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
  issueType: string;
  autoCreate: boolean;
  // Phase 15.4 two-way sync. Transition NAMEs (matched case-insensitively
  // against /transitions) the outbound sync drives a linked issue through.
  resolveTransition: string; // → fixed (manual or auto-close-on-green)
  reopenTransition: string; // → regressed (ingest auto-reopen)
}

// Defaults when an org hasn't customised the transition names (NULL columns).
// "Done" / "To Do" are the out-of-the-box Jira workflow state names.
const DEFAULT_RESOLVE_TRANSITION = "Done";
const DEFAULT_REOPEN_TRANSITION = "To Do";

export interface JiraIssueResult {
  key: string;
  url: string;
}

export async function getJiraConfig(orgId: number): Promise<JiraConfig | null> {
  // `organizations` has no RLS (cross-org infrastructure table). The
  // tenant boundary here is the `WHERE id = $1` clause — orgId always
  // originates from req.user!.orgId or a run's org_id, never from
  // request input. tenantQuery would be wrong here: setting
  // app.current_org_id requires already knowing which org to scope to,
  // which is exactly what this query exists to answer (config lookup
  // before any tenant work begins).
  const result = await pool.query(
    `SELECT jira_base_url, jira_email, jira_api_token, jira_project_key,
            jira_issue_type, jira_auto_create,
            jira_resolve_transition, jira_reopen_transition
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
    apiToken: decryptSecret(row.jira_api_token)!,
    projectKey: row.jira_project_key,
    issueType: row.jira_issue_type ?? "Bug",
    autoCreate: !!row.jira_auto_create,
    resolveTransition: row.jira_resolve_transition || DEFAULT_RESOLVE_TRANSITION,
    reopenTransition: row.jira_reopen_transition || DEFAULT_REOPEN_TRANSITION,
  };
}

function authHeader(cfg: JiraConfig): string {
  return "Basic " + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString("base64");
}

// 10s timeout on every Jira API call. Jira Cloud occasionally hangs for
// minutes during incidents; without a timeout the auto-create loop blocks
// the post-upload pipeline (and the Versions panel hangs the dashboard
// when a user clicks into release readiness).
const JIRA_TIMEOUT_MS = 10_000;

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
    signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Log the body server-side for debugging; Jira error responses
    // sometimes include the request payload back, so the raw body
    // can echo internal data we shouldn't surface to the user.
    console.error(`Jira create failed: ${res.status}`, body);
    throw new Error(`Jira create failed: HTTP ${res.status}`);
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

  // Fast path, no lock: the issue is already tracked. The overwhelming common
  // case (the same failure recurs run after run) so we keep it lock-free.
  const existing = await tenantQuery(
    orgId,
    "SELECT issue_key, issue_url FROM failure_jira_issues WHERE org_id = $1 AND fingerprint = $2",
    [orgId, fingerprint]
  );
  if (existing.rows.length > 0) {
    return { key: existing.rows[0].issue_key, url: existing.rows[0].issue_url };
  }

  // Slow path: serialize first-time creators of the SAME fingerprint behind a
  // per-(org, fingerprint) transaction-scoped advisory lock, then re-check
  // under it. Without this, two concurrent callers — parallel CI shards both
  // running autoCreateIssuesForRun, or a user's manual "create issue" racing
  // the auto-create pass — can each pass the fast-path SELECT, each POST a Jira
  // issue, and create TWO tickets for one failure; only one row is then
  // recorded (the loser's INSERT hits ON CONFLICT DO NOTHING) and its ticket is
  // orphaned. The lock makes check → create → record atomic per fingerprint.
  // It's keyed with org_id so identical fingerprints in different orgs never
  // contend, and held only across this one Jira call (bounded by JIRA_TIMEOUT_MS).
  // Same pg_advisory_xact_lock pattern as scheduled-reports.ts.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgId)]);
    // Two-int key form: (org_id, hashtext(fingerprint)). A hashtext collision
    // between two distinct fingerprints in one org only over-serializes them
    // (a negligible cost) — correctness still rests on the exact-match re-check
    // and the (org_id, fingerprint) unique index, not on the hash.
    await client.query(
      "SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)",
      [orgId, fingerprint]
    );

    // Re-check under the lock: a racing caller may have created and recorded the
    // issue between our fast-path SELECT and acquiring the lock.
    const recheck = await client.query(
      "SELECT issue_key, issue_url FROM failure_jira_issues WHERE org_id = $1 AND fingerprint = $2",
      [orgId, fingerprint]
    );
    if (recheck.rows.length > 0) {
      await client.query("COMMIT");
      return { key: recheck.rows[0].issue_key, url: recheck.rows[0].issue_url };
    }

    // We hold the lock and no row exists — we are the sole creator. A throw from
    // createJiraIssue rolls back and releases the lock, so a transient Jira
    // failure doesn't permanently block the fingerprint: the next caller retries.
    const issue = await createJiraIssue(cfg, summary, description);

    // Bare INSERT — no ON CONFLICT. The lock + re-check above make a duplicate
    // (org_id, fingerprint) impossible under correct operation, so a unique
    // violation here would mean a row was written outside this lock (a real
    // bug). Let it throw → rollback → rethrow rather than DO NOTHING: swallowing
    // it would return the just-created `issue` whose row was never recorded,
    // leaving an orphaned ticket the next call can't dedup against. Fail loud
    // (guard rail 5); the unique index stays the correctness backstop.
    await client.query(
      `INSERT INTO failure_jira_issues (org_id, fingerprint, issue_key, issue_url, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [orgId, fingerprint, issue.key, issue.url, userId]
    );

    await client.query("COMMIT");
    return issue;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => { /* connection already broken */ });
    throw err;
  } finally {
    client.release();
  }
}

// Cap auto-created Jira issues per run so a catastrophic run (hundreds of
// failures) doesn't fan out into hundreds of ticket-creating HTTP calls and
// flood the project — mirrors annotations.ts's MAX_ANNOTATIONS. This also
// bounds the post-upload pipeline's worst case: createIssueForFingerprint
// holds one pooled connection + a per-fingerprint advisory lock across each
// (bounded-timeout) Jira call on the first-time-create path, so the cap caps
// that exposure too. Failures beyond the cap still appear in the PR comment
// and the dashboard — they just don't get an auto-filed ticket.
export const MAX_AUTO_CREATE_ISSUES = 20;

/**
 * Flatten a run's failed tests into the (spec, test) pairs auto-create will
 * open issues for, capped at `cap`. Pure and exported so the cap + drop
 * accounting are unit-testable without a DB or the Jira API. `dropped` is the
 * count beyond the cap, so the caller can log a truncation rather than
 * silently dropping tickets (guard rail: no silent caps).
 */
export function selectFailuresForAutoCreate(
  run: NormalizedRun,
  cap = MAX_AUTO_CREATE_ISSUES,
): { selected: Array<{ spec: NormalizedSpec; test: NormalizedTest }>; dropped: number } {
  const failed = run.specs.flatMap((spec) =>
    spec.tests
      .filter((t) => t.status === "failed")
      .map((test) => ({ spec, test })),
  );
  return { selected: failed.slice(0, cap), dropped: Math.max(0, failed.length - cap) };
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

    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:7778";

    const { selected, dropped } = selectFailuresForAutoCreate(run);
    if (dropped > 0) {
      // Don't truncate silently: a busy run losing tickets past the cap should
      // be visible to an operator, not look like full coverage.
      console.warn(
        `Jira auto-create: run ${runId} (org ${orgId}) has ${selected.length + dropped} failed tests, ` +
        `over the ${MAX_AUTO_CREATE_ISSUES}-issue cap — ${dropped} did not get a ticket ` +
        `(still listed in the PR comment + dashboard).`
      );
    }

    for (const { spec, test } of selected) {
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
        console.error("Jira auto-create failed:", safeLog(err));
      }
    }
  } catch (err) {
    // A Jira fetch error can carry the configured jira_base_url; wrap it in
    // safeLog so an attacker-influenced message can't inject a fake log line
    // (CWE-117), matching the convention in uploads.ts / runs.ts.
    console.error("autoCreateIssuesForRun error:", safeLog(err));
  }
}

// ── Phase 15.4: outbound two-way sync ────────────────────────────────────
//
// When a Flakey error group transitions, reflect it onto the linked Jira issue
// (best-effort egress over the existing Jira client's auth + timeout):
//   • → fixed     (manual PATCH or auto-close-on-green): drive the issue
//                 through `resolveTransition` and comment that the test is
//                 green for N runs.
//   • → regressed (ingest-time auto-reopen): drive the issue through
//                 `reopenTransition` and comment that the failure is back.
// Jira itself has no run data, so the regressed-reopen is the demo-able "wow."
//
// Every primitive throws on HTTP error; the high-level syncErrorGroupTransition
// swallows + logs so a Jira outage can never break ingest or the retention
// sweep (the DB transition already happened — Jira reflection is best-effort,
// matching the outbound-webhook dispatch convention).

export interface JiraTransition {
  id: string;
  name: string;
}

/**
 * List the transitions currently available on an issue (workflow-state +
 * permission dependent — so we always fetch live rather than cache an id).
 * Throws on HTTP error.
 */
export async function fetchIssueTransitions(
  cfg: JiraConfig,
  issueKey: string
): Promise<JiraTransition[]> {
  const res = await fetch(
    `${cfg.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`,
    {
      headers: { Authorization: authHeader(cfg), Accept: "application/json" },
      signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`Jira transitions fetch failed: ${res.status}`, body);
    throw new Error(`Jira transitions fetch failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { transitions?: Array<{ id: string; name: string }> };
  return (data.transitions ?? []).map((t) => ({ id: t.id, name: t.name }));
}

/**
 * Add a plain-text comment to an issue. Throws on HTTP error.
 */
export async function addIssueComment(
  cfg: JiraConfig,
  issueKey: string,
  body: string
): Promise<void> {
  const res = await fetch(
    `${cfg.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`,
    {
      method: "POST",
      headers: {
        Authorization: authHeader(cfg),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
    }
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`Jira comment failed: ${res.status}`, errBody);
    throw new Error(`Jira comment failed: HTTP ${res.status}`);
  }
}

/**
 * Drive an issue through the named transition (case-insensitive match against
 * its currently-available transitions). Returns false (without throwing) when
 * no transition with that name is currently available — a common, benign case
 * (the issue is already in the target state, or the workflow doesn't expose it
 * from the current state). Throws only on an actual HTTP failure.
 */
export async function transitionIssue(
  cfg: JiraConfig,
  issueKey: string,
  transitionName: string
): Promise<boolean> {
  const transitions = await fetchIssueTransitions(cfg, issueKey);
  const needle = transitionName.trim().toLowerCase();
  const match = transitions.find((t) => t.name.trim().toLowerCase() === needle);
  if (!match) return false;

  const res = await fetch(
    `${cfg.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`,
    {
      method: "POST",
      headers: {
        Authorization: authHeader(cfg),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ transition: { id: match.id } }),
      signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`Jira transition failed: ${res.status}`, body);
    throw new Error(`Jira transition failed: HTTP ${res.status}`);
  }
  return true;
}

/**
 * The linked Jira issue for an (org, fingerprint), or null when none is
 * tracked. RLS-scoped via tenantQuery — only this org's linkage is visible.
 */
export async function getLinkedIssue(
  orgId: number,
  fingerprint: string
): Promise<JiraIssueResult | null> {
  const r = await tenantQuery(
    orgId,
    "SELECT issue_key, issue_url FROM failure_jira_issues WHERE org_id = $1 AND fingerprint = $2",
    [orgId, fingerprint]
  );
  if (r.rows.length === 0) return null;
  return { key: r.rows[0].issue_key, url: r.rows[0].issue_url };
}

export type JiraSyncDirection = "fixed" | "regressed";

/**
 * Reflect a Flakey error-group transition onto its linked Jira issue.
 *
 * Best-effort and RESILIENT: any failure (no config, no linkage, Jira down) is
 * swallowed + logged and returns null — it must NEVER break the caller (ingest
 * or the retention sweep), because the DB transition already committed. Returns
 * the linked issue key on a successful reflection, null otherwise, so the
 * caller can audit only when Jira actually moved.
 *
 * `note` is a human-readable reason woven into the comment (e.g.
 * "test green for 3 runs"). The comment is always prefixed "Flakey:".
 */
export async function syncErrorGroupTransition(
  orgId: number,
  fingerprint: string,
  direction: JiraSyncDirection,
  note: string
): Promise<string | null> {
  try {
    const cfg = await getJiraConfig(orgId);
    if (!cfg) return null;

    const linked = await getLinkedIssue(orgId, fingerprint);
    if (!linked) return null;

    const transitionName =
      direction === "fixed" ? cfg.resolveTransition : cfg.reopenTransition;

    // Transition first, then comment. A failed transition still lets us record
    // the comment so the trail isn't lost, but we surface (return) only when at
    // least the comment lands — the caller audits on a non-null return.
    const moved = await transitionIssue(cfg, linked.key, transitionName);
    await addIssueComment(cfg, linked.key, `Flakey: ${note}`);

    if (!moved) {
      console.warn(
        `Jira sync: transition "${transitionName}" not available on ${linked.key} ` +
        `(org ${orgId}, fingerprint ${fingerprint}) — left a comment only.`
      );
    }
    return linked.key;
  } catch (err) {
    // A Jira fetch error can carry the configured jira_base_url; wrap in safeLog
    // so an attacker-influenced message can't inject a fake log line (CWE-117).
    console.error("syncErrorGroupTransition error:", safeLog(err));
    return null;
  }
}

// ── Version / release APIs ───────────────────────────────────────────────

export interface JiraVersion {
  id: string;
  name: string;
  description?: string;
  released: boolean;
  archived: boolean;
  releaseDate?: string;
  startDate?: string;
  overdue?: boolean;
  projectId?: number;
}

export interface JiraVersionIssueCounts {
  issuesAffectedCount: number;
  issuesFixedCount: number;
  issueCountWithCustomFieldsShowingVersion?: number;
}

export interface JiraIssueSummary {
  key: string;
  url: string;
  summary: string;
  status: string;
  statusCategory: string;
  assignee: string | null;
}

/**
 * Fetch every version for the configured Jira project. Sorted by Jira's own
 * order (typically newest last). Throws on HTTP errors.
 */
export async function fetchProjectVersions(cfg: JiraConfig): Promise<JiraVersion[]> {
  const res = await fetch(
    `${cfg.baseUrl}/rest/api/2/project/${encodeURIComponent(cfg.projectKey)}/versions`,
    {
      headers: { Authorization: authHeader(cfg), Accept: "application/json" },
      signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`Jira versions fetch failed: ${res.status}`, body);
    throw new Error(`Jira versions fetch failed: HTTP ${res.status}`);
  }
  return (await res.json()) as JiraVersion[];
}

/**
 * Case-insensitive name match against the project's version list. Returns
 * null when nothing matches so callers can fall back to prompting the user.
 */
export async function findVersionByName(
  cfg: JiraConfig,
  name: string
): Promise<JiraVersion | null> {
  const versions = await fetchProjectVersions(cfg);
  const needle = name.trim().toLowerCase();
  return versions.find((v) => v.name.trim().toLowerCase() === needle) ?? null;
}

export async function fetchVersionIssueCounts(
  cfg: JiraConfig,
  versionId: string
): Promise<JiraVersionIssueCounts> {
  const res = await fetch(
    `${cfg.baseUrl}/rest/api/2/version/${encodeURIComponent(versionId)}/relatedIssueCounts`,
    {
      headers: { Authorization: authHeader(cfg), Accept: "application/json" },
      signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`Jira counts fetch failed: ${res.status}`, body);
    throw new Error(`Jira counts fetch failed: HTTP ${res.status}`);
  }
  return (await res.json()) as JiraVersionIssueCounts;
}

/**
 * Issues with the given fixVersion, ordered so unresolved show first. We
 * cap at `limit` so the readiness panel stays snappy.
 */
export async function fetchIssuesForVersion(
  cfg: JiraConfig,
  versionName: string,
  limit = 25
): Promise<JiraIssueSummary[]> {
  // Escape backslashes then double quotes for JQL safety. Order matters:
  // doing quotes first leaves the introduced \" vulnerable to a later
  // \-escape pass, so do \ first. CodeQL js/incomplete-sanitization
  // flagged the prior single-pass form.
  const safeName = versionName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const jql = `project = "${cfg.projectKey}" AND fixVersion = "${safeName}" ORDER BY resolution ASC, updated DESC`;
  const res = await fetch(`${cfg.baseUrl}/rest/api/2/search`, {
    method: "POST",
    headers: {
      Authorization: authHeader(cfg),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      jql,
      maxResults: limit,
      fields: ["summary", "status", "assignee"],
    }),
    signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`Jira search failed: ${res.status}`, body);
    throw new Error(`Jira search failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    issues: Array<{
      key: string;
      fields: {
        summary: string;
        status: { name: string; statusCategory: { key: string } };
        assignee: { displayName: string } | null;
      };
    }>;
  };
  return data.issues.map((i) => ({
    key: i.key,
    url: `${cfg.baseUrl}/browse/${i.key}`,
    summary: i.fields.summary,
    status: i.fields.status?.name ?? "Unknown",
    statusCategory: i.fields.status?.statusCategory?.key ?? "new",
    assignee: i.fields.assignee?.displayName ?? null,
  }));
}

function hashString(s: string): string {
  // 64 bits of SHA-256 (16 hex chars). djb2's prior 32-bit output had ~10%
  // collision probability around 10k unique failures — reachable in a busy
  // org over months — and a collision would mean a real failure silently
  // inherits another failure's Jira issue and never gets its own ticket.
  return `jira-${createHash("sha256").update(s).digest("hex").slice(0, 16)}`;
}
