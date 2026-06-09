-- Flaky-actionability config: turns the existing advisory quarantine list into
-- something the server can act on. Adds per-org auto-quarantine policy knobs and
-- a flaky-rate alert threshold on organizations, plus a `source` column on
-- quarantined_tests to distinguish operator-added ('manual') entries from
-- server-added ('auto') ones. organizations has NO row-level security (see the
-- header in src/routes/orgs.ts) so these columns need no policy; quarantined_tests
-- already has RLS (migration 017) and the new column is covered by its existing
-- org-isolation policy unchanged.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS auto_quarantine_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS auto_quarantine_min_flips INT NOT NULL DEFAULT 4;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS auto_quarantine_min_runs INT NOT NULL DEFAULT 10;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS flaky_alert_threshold NUMERIC;

ALTER TABLE quarantined_tests ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
