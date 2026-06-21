-- Error-group triage fields: a due date and a priority on the triage unit.
-- Phase 15.1 (remainder) — the assignee slice already shipped in migration 063;
-- this adds the two other "this is a thing a person is accountable to" columns.
--
--   target_date  — when the failure should be resolved (the SLA hook; nullable).
--   priority     — manual triage priority (a derived default lands in 15.2).
--
-- Both are fully additive. error_groups already has RLS (migration 013) tied to
-- org_id, and new columns inherit that policy — no new policy needed. NULL means
-- "unset" for both (no SLA / no priority), the conservative default.
ALTER TABLE error_groups
  ADD COLUMN IF NOT EXISTS target_date DATE;

ALTER TABLE error_groups
  ADD COLUMN IF NOT EXISTS priority TEXT;

-- App-level validation already rejects out-of-enum priorities (PATCH
-- /errors/:fingerprint), but a CHECK keeps the DB honest against any future
-- writer — same belt-and-braces pattern as migration 044's status CHECK.
-- Guarded so the migration is idempotent (CHECK constraints have no
-- IF NOT EXISTS form).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'error_groups_priority_check'
  ) THEN
    ALTER TABLE error_groups
      ADD CONSTRAINT error_groups_priority_check
      CHECK (priority IN ('low', 'medium', 'high', 'critical'));
  END IF;
END $$;

-- Partial index for the "overdue" list filter — only rows with a target_date
-- carry an SLA, so keep the NULL (no-due-date) majority out of the index.
CREATE INDEX IF NOT EXISTS idx_error_groups_target_date
  ON error_groups(org_id, target_date) WHERE target_date IS NOT NULL;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO flakey_app;
