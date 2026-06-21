-- Phase 15.2 — data-native automation on the error-group triage unit.
--
-- Three additive pieces, all on already-RLS'd / no-RLS tables (no new policy):
--
--   1. A new status value `regressed` — the ingest-time auto-reopen target when
--      a fingerprint we'd marked `fixed` reappears. Rewrites migration 044's
--      CHECK to add it (drop + re-add; CHECK has no IF NOT EXISTS form, so the
--      DROP IF EXISTS keeps it idempotent).
--   2. recurrence_count / last_recurred_at on error_groups — bumped + stamped by
--      the ingest recurrence hook (src/error-recurrence.ts). Additive columns on
--      a table that already has RLS (migration 013) → inherit the policy.
--   3. organizations.triage_autoclose_days — the per-org opt-in window for the
--      nightly auto-close-on-green sweep (src/retention.ts). Lives alongside
--      retention_days (migration 008). `organizations` has no RLS (read via
--      pool.query on a trusted org id, the getProviderConfig pattern), so no
--      policy is needed. NULL default = OFF (conservative; silently flipping
--      state is opt-in only).

-- 1. Extend the status CHECK with 'regressed'.
ALTER TABLE error_groups DROP CONSTRAINT IF EXISTS error_groups_status_check;
ALTER TABLE error_groups ADD CONSTRAINT error_groups_status_check
  CHECK (status IN ('open','investigating','known','fixed','ignored','regressed'));

-- 2. Recurrence bookkeeping on the triage unit.
ALTER TABLE error_groups
  ADD COLUMN IF NOT EXISTS recurrence_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE error_groups
  ADD COLUMN IF NOT EXISTS last_recurred_at TIMESTAMPTZ;

-- 3. Per-org auto-close window (NULL = OFF). Sits beside retention_days so the
-- two nightly per-org settings are read together in the retention pass.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS triage_autoclose_days INTEGER;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO flakey_app;
