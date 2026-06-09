-- 062_ai_fix_prs_one_open_per_target.sql
-- Concurrency guard for the AI fix-PR flow (POST /analyze/fix-pr): at most one
-- OPEN fix PR per (org, target). The route "claims" this slot with an INSERT
-- before it talks to the git provider, so two concurrent requests can't both
-- open a draft PR against the customer's repo. Partial (status='open') so a
-- closed/merged PR doesn't block opening a fresh fix later.

CREATE UNIQUE INDEX IF NOT EXISTS ai_fix_prs_one_open_per_target
  ON ai_fix_prs (org_id, target_type, target_key)
  WHERE status = 'open';
