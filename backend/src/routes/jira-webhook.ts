// Phase 15.4 — INBOUND Jira webhook receiver (the new external trust boundary).
//
// Jira posts here on issue events. On an issue-CLOSED event we set the linked
// error_groups.status to `fixed`. This is the one ingress boundary added by
// 15.4, so it is deliberately the most defensive route in the app:
//
//   • FLAG-GATED OFF BY DEFAULT. FLAKEY_JIRA_WEBHOOK_ENABLED must be "true" or
//     the route returns a clean 404 (same kill-switch shape as SSO / SCIM).
//     Enabling it is an operator decision gated on CISO / security sign-off
//     (inbound webhooks transitioning our triage state from an external system
//     is a SOC 2 / GovRAMP-relevant change — see backend/docs/integrations.md).
//   • HMAC-VERIFIED, FAIL CLOSED. Every request must carry a valid
//     X-Hub-Signature (sha256=<hex hmac of the raw body> using the per-org
//     jira_webhook_secret). Missing / malformed / mismatching signature ⇒ 401.
//     No secret configured for the resolved org ⇒ 401 (can't verify ⇒ reject).
//   • NEVER TRUSTS THE PAYLOAD'S ORG. The org is resolved SERVER-SIDE from the
//     issue key via the failure_jira_issues linkage — the payload cannot name
//     an org. A signature is checked against THAT org's secret. An attacker who
//     knows an issue key but not the org's secret can't forge a request.
//   • RATE-LIMITED at the mount (jiraWebhookLimiter in index.ts).
//   • The status flip runs under the resolved org's RLS context (tenantQuery).
//
// Because the org is keyed off the issue link and the secret is per-org, the
// verification order is: parse issue key → resolve org+secret from the link →
// verify HMAC against that secret → act. An unlinked issue (no row) is a 204
// no-op (nothing to transition) WITHOUT leaking whether the org exists.

import { Router, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import pool, { tenantQuery } from "../db.js";
import { decryptSecret } from "../crypto.js";
import { logAudit } from "../audit.js";
import { safeLog } from "../log.js";

const router = Router();

// Whole-feature kill switch. OFF unless an operator explicitly opts in after
// security sign-off. When off, the route 404s so nothing half-wires.
export const JIRA_WEBHOOK_ENABLED = process.env.FLAKEY_JIRA_WEBHOOK_ENABLED === "true";

const SIGNATURE_HEADER = "x-hub-signature";

/**
 * Constant-time compare of the `sha256=<hex>` signature header against an HMAC
 * of `rawBody` keyed by `secret`. Returns false on any shape mismatch (missing
 * header, wrong prefix, non-hex, length mismatch) — never throws, always fails
 * closed. Exported for unit testing.
 */
export function verifyJiraSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader || !secret) return false;
  // Accept "sha256=<hex>"; reject anything else.
  const m = /^sha256=([0-9a-f]+)$/i.exec(signatureHeader.trim());
  if (!m) return false;
  const provided = Buffer.from(m[1], "hex");

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  // timingSafeEqual throws on length mismatch — guard first so a wrong-length
  // signature is a clean false, not an exception (still constant-time: the
  // length is not secret).
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Pull the issue key from a Jira webhook payload. Jira's `jira:issue_updated` /
 * `jira:issue_*` events carry `{ issue: { key } }`. Returns null when absent.
 */
export function extractIssueKey(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const issue = (payload as { issue?: { key?: unknown } }).issue;
  const key = issue?.key;
  return typeof key === "string" && key.length > 0 ? key : null;
}

/**
 * Whether a payload represents an issue being CLOSED/resolved. Jira models this
 * as the issue's status moving into the `done` status-category. We read the
 * post-change status from `issue.fields.status.statusCategory.key === 'done'`,
 * which is workflow-name-agnostic (a "Closed", "Done", or "Resolved" column all
 * map to the `done` category).
 */
export function isIssueClosed(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const cat = (payload as {
    issue?: { fields?: { status?: { statusCategory?: { key?: unknown } } } };
  }).issue?.fields?.status?.statusCategory?.key;
  return cat === "done";
}

// POST /jira/webhook — mounted in index.ts with express.raw() so req.body is the
// exact bytes Jira signed (HMAC is over raw bytes, not a re-serialised object).
router.post("/", async (req: Request, res: Response) => {
  // Fail closed on the flag FIRST — a disabled instance reveals nothing.
  if (!JIRA_WEBHOOK_ENABLED) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  try {
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");

    // Parse the payload from the raw bytes. A malformed body is a 400 (we never
    // got far enough to need org context).
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8") || "null");
    } catch {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }

    const issueKey = extractIssueKey(payload);
    if (!issueKey) {
      res.status(400).json({ error: "Missing issue key" });
      return;
    }

    // Resolve org + secret SERVER-SIDE from the issue link. The payload never
    // names the org. failure_jira_issues is FORCE-RLS, and we don't yet have an
    // org context to scope to — that's exactly what this lookup answers — so we
    // can't use a plain tenantQuery (it would filter everything out). We use the
    // narrow SECURITY DEFINER function lookup_jira_webhook_link (migration 070),
    // the same controlled cross-org resolution the SCIM token auth uses
    // (lookup_scim_token). It returns ONLY (org_id, fingerprint, encrypted
    // secret) for the supplied issue key; most-recent link wins if two orgs
    // pathologically share a key (each still needs its own secret to verify).
    const linkRes = await pool.query(
      "SELECT org_id, fingerprint, jira_webhook_secret FROM lookup_jira_webhook_link($1)",
      [issueKey]
    );

    // No link → nothing to transition. 204 without revealing whether the org or
    // issue exists (no signature check needed — there's no secret to check
    // against, and we leak nothing).
    if (linkRes.rows.length === 0) {
      res.status(204).end();
      return;
    }

    const orgId: number = linkRes.rows[0].org_id;
    const fingerprint: string = linkRes.rows[0].fingerprint;
    const secret = decryptSecret(linkRes.rows[0].jira_webhook_secret);

    // No secret configured for this org ⇒ can't verify ⇒ fail closed.
    if (!secret) {
      res.status(401).json({ error: "Signature verification failed" });
      return;
    }

    // Verify the HMAC against the raw bytes with the resolved org's secret.
    const sigHeader = req.headers[SIGNATURE_HEADER];
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (!verifyJiraSignature(rawBody, sig, secret)) {
      res.status(401).json({ error: "Signature verification failed" });
      return;
    }

    // Verified. Only issue-closed flips status; other events are a benign 204.
    if (!isIssueClosed(payload)) {
      res.status(204).end();
      return;
    }

    // Flip the linked error group to `fixed` under the resolved org's RLS
    // context. Idempotent: a second close of the same issue re-sets `fixed`
    // (a no-op) and re-audits — acceptable for an external best-effort signal.
    await tenantQuery(
      orgId,
      `INSERT INTO error_groups (org_id, fingerprint, status, updated_at)
       VALUES ($1, $2, 'fixed', NOW())
       ON CONFLICT (org_id, fingerprint)
       DO UPDATE SET status = 'fixed', updated_at = NOW()`,
      [orgId, fingerprint]
    );

    await logAudit(orgId, null, "jira.webhook.issue_closed", "error_group", fingerprint, {
      issue_key: issueKey,
      new_status: "fixed",
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    // safeLog: a Jira payload / DB error could echo attacker-controlled text.
    console.error("POST /jira/webhook error:", safeLog(err));
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
