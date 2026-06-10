-- Error-group assignee: lightweight "who's chasing this failure" ownership.
-- Surfaced on the errors page and within a release's failure-triage list.
-- Deliberately just an assignee (not a due-date / workflow) — escalation to
-- tracked work stays the Jira file-bug path; this is the pre-ticket triage moment.
--
-- error_groups already has RLS (migration 013) tied to org_id, and a new column
-- inherits that policy — no new policy needed. ON DELETE SET NULL mirrors how
-- error_notes.user_id releases the FK when a user is removed.
ALTER TABLE error_groups
  ADD COLUMN IF NOT EXISTS assigned_to INT REFERENCES users(id) ON DELETE SET NULL;

-- Partial index supports "assigned to me" / "assigned" filtering without
-- bloating the index with the common unassigned (NULL) rows.
CREATE INDEX IF NOT EXISTS idx_error_groups_assigned_to
  ON error_groups(org_id, assigned_to) WHERE assigned_to IS NOT NULL;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO flakey_app;
