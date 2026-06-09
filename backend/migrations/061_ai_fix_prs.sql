-- 061_ai_fix_prs.sql
-- Tracks AI-generated "fix PR" attempts so the UI can link to the draft PR an
-- analysis opened and avoid spawning duplicates. One row per opened PR. The
-- generated change is always opened as a DRAFT for human review — never
-- auto-merged (see backend/src/routes/analyze.ts /analyze/fix-pr).
--
-- Tenant table: org-isolated under RLS exactly like ai_analyses (migration 017).

CREATE TABLE IF NOT EXISTS ai_fix_prs (
  id SERIAL PRIMARY KEY,
  org_id INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- What the fix targets, mirroring ai_analyses' (target_type, target_key):
  -- 'error' (fingerprint) or 'flaky' (fullTitle|suiteName).
  target_type TEXT NOT NULL,
  target_key TEXT NOT NULL,
  provider TEXT NOT NULL,          -- 'github' | 'gitlab' | 'bitbucket'
  branch TEXT NOT NULL,
  file_path TEXT,                  -- repo-relative file the patch touched
  pr_number INT,                   -- provider PR/MR number
  pr_url TEXT,                     -- web URL to the (draft) PR
  status TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'merged' | 'closed' (best-effort)
  created_by INT REFERENCES users(id),  -- the user who triggered it (nullable)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_fix_prs_org ON ai_fix_prs(org_id);
-- Lookup "is there already a fix PR for this target?" before opening another.
CREATE INDEX IF NOT EXISTS idx_ai_fix_prs_target ON ai_fix_prs(org_id, target_type, target_key);

ALTER TABLE ai_fix_prs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_fix_prs FORCE ROW LEVEL SECURITY;
-- Canonical *_tenant policy name (the convention since migrations 042/043 —
-- NOT the legacy *_org_isolation form, which rls_policy_uniqueness pins against).
DROP POLICY IF EXISTS ai_fix_prs_tenant ON ai_fix_prs;
CREATE POLICY ai_fix_prs_tenant ON ai_fix_prs
  USING (org_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (org_id::text = current_setting('app.current_org_id', true));
