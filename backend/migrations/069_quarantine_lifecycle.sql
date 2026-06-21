-- Phase 15.3 — quarantine lifecycle.
--
-- Two additive, nullable columns on quarantined_tests (created in migration 017,
-- given a `source` column in 060). The table already has RLS (017's
-- quarantined_tests_org_isolation policy) and is org-scoped, so additive columns
-- inherit the policy — no new policy needed.
--
--   - expires_at: when this quarantine should auto-lift. NULL = no expiry (muted
--     indefinitely — the rot risk 15.3 surfaces). The nightly retention sweep
--     (src/retention.ts) removes rows whose expires_at is in the past and writes
--     a `quarantine.expired` audit row.
--   - error_fingerprint: optional link from a quarantine to its triage error
--     group (md5(error_message || '|' || suite_name)). Lets the triage view and
--     the flaky→quarantine SUGGESTION (read-side only — we never auto-mute) tie a
--     muted test back to its error group.
--
-- Pure ADD COLUMN IF NOT EXISTS — idempotent, touches no CHECK/constraint, so
-- re-applying the whole migration suite top-to-bottom stays clean.

ALTER TABLE quarantined_tests
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE quarantined_tests
  ADD COLUMN IF NOT EXISTS error_fingerprint TEXT;

-- The sweep filters on expires_at < NOW(); a partial index keeps that scan cheap
-- as the table grows (only rows with an expiry are ever candidates).
CREATE INDEX IF NOT EXISTS idx_quarantined_tests_expires_at
  ON quarantined_tests(expires_at)
  WHERE expires_at IS NOT NULL;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO flakey_app;
