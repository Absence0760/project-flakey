-- Schema-design audit findings L1, L2: two user-attribution FKs had no ON DELETE
-- action (default NO ACTION / RESTRICT), so deleting a user is silently blocked
-- whenever they appear as an inviter or quarantiner. Both columns are audit
-- metadata, not ownership — ON DELETE SET NULL is the right action (matches
-- error_notes.user_id, notes.user_id, failure_jira_issues.created_by, and the
-- *_by attribution columns on the release junction tables).
--
-- Constraint names are Postgres's deterministic <table>_<column>_fkey defaults.
-- DROP ... IF EXISTS before re-adding keeps the migration idempotent.

-- L1: org_invites.invited_by — currently NOT NULL, so drop NOT NULL before SET NULL.
-- invited_by is only ever written (req.user.id); no route reads it back, so
-- making it nullable is safe.
ALTER TABLE org_invites ALTER COLUMN invited_by DROP NOT NULL;
ALTER TABLE org_invites DROP CONSTRAINT IF EXISTS org_invites_invited_by_fkey;
ALTER TABLE org_invites
  ADD CONSTRAINT org_invites_invited_by_fkey
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL;

-- L2: quarantined_tests.quarantined_by — already nullable; the read path
-- (LEFT JOIN users ON quarantined_by) already tolerates NULL.
ALTER TABLE quarantined_tests DROP CONSTRAINT IF EXISTS quarantined_tests_quarantined_by_fkey;
ALTER TABLE quarantined_tests
  ADD CONSTRAINT quarantined_tests_quarantined_by_fkey
  FOREIGN KEY (quarantined_by) REFERENCES users(id) ON DELETE SET NULL;
