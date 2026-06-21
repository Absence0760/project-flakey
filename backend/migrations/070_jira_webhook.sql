-- Phase 15.4 — two-way Jira sync configuration.
--
-- Adds the per-org settings the two-way sync needs, alongside the existing
-- Jira config columns on `organizations` (migration 022). `organizations` has
-- no RLS (cross-org infrastructure table read via pool.query on a trusted org
-- id, the getJiraConfig pattern), so no policy is needed — all three columns
-- are fully additive and inherit nothing.
--
--   jira_webhook_secret    — encrypted (v1: AES-GCM, see crypto.ts) HMAC shared
--                            secret for the INBOUND POST /jira/webhook receiver.
--                            NULL = no secret configured → the receiver fails
--                            closed for that org (can't verify ⇒ reject). Stored
--                            encrypted exactly like jira_api_token.
--   jira_resolve_transition — the Jira transition NAME the OUTBOUND sync drives
--                            the linked issue through on a → fixed transition
--                            (manual or auto-close-on-green). NULL ⇒ default
--                            "Done" at the call site. Configurable because Jira
--                            workflows name their done-state differently.
--   jira_reopen_transition  — the transition NAME used on a → regressed
--                            transition (ingest-time auto-reopen). NULL ⇒
--                            default "To Do" at the call site.
--
-- Transition NAMEs (not ids) are stored: ids are per-project and opaque, names
-- are what an admin sees in the Jira workflow editor. The outbound client
-- resolves name → id against /transitions at call time.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS jira_webhook_secret TEXT;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS jira_resolve_transition TEXT;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS jira_reopen_transition TEXT;

-- ---------------------------------------------------------------------------
-- Cross-org link resolution for the INBOUND webhook, the SCIM-token pattern
-- (migration 057's lookup_scim_token). failure_jira_issues is FORCE-RLS, so the
-- app role can't read another org's link with a plain query — but the inbound
-- receiver must resolve which org owns an externally-supplied issue key BEFORE
-- it has any org context (chicken/egg). A narrow SECURITY DEFINER function does
-- exactly and only that: given an issue key, return the owning org, its linked
-- fingerprint, and that org's (still-encrypted) webhook secret, so the receiver
-- can verify the HMAC against the right secret. It exposes nothing an attacker
-- can exploit without already knowing the org's secret: the encrypted secret is
-- returned but the HMAC check happens app-side after decrypt, and a wrong issue
-- key returns no rows. Most-recent link wins if (pathologically) two orgs link
-- the same key — they'd still each need their own secret to pass verification.
CREATE OR REPLACE FUNCTION lookup_jira_webhook_link(p_issue_key TEXT)
RETURNS TABLE(org_id INT, fingerprint TEXT, jira_webhook_secret TEXT)
LANGUAGE sql SECURITY DEFINER
AS $$
  SELECT fji.org_id, fji.fingerprint, o.jira_webhook_secret
  FROM failure_jira_issues fji
  JOIN organizations o ON o.id = fji.org_id
  WHERE fji.issue_key = p_issue_key
  ORDER BY fji.created_at DESC
  LIMIT 1;
$$;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO flakey_app;
GRANT EXECUTE ON FUNCTION lookup_jira_webhook_link(TEXT) TO flakey_app;
