-- Link releases to the runs and manual tests that count toward them, and
-- let checklist items carry an auto-evaluation rule so items like "critical
-- tests passing" tick themselves based on live data instead of honor system.

-- ── Pinned runs for a release ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS release_runs (
  release_id  INT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  run_id      INT NOT NULL REFERENCES runs(id)     ON DELETE CASCADE,
  org_id      INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  added_by    INT REFERENCES users(id) ON DELETE SET NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (release_id, run_id)
);
CREATE INDEX IF NOT EXISTS idx_release_runs_release ON release_runs(release_id);
ALTER TABLE release_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY release_runs_tenant ON release_runs
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

-- ── Pinned manual tests for a release ────────────────────────────────────
CREATE TABLE IF NOT EXISTS release_manual_tests (
  release_id      INT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  manual_test_id  INT NOT NULL REFERENCES manual_tests(id) ON DELETE CASCADE,
  org_id          INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  added_by        INT REFERENCES users(id) ON DELETE SET NULL,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (release_id, manual_test_id)
);
CREATE INDEX IF NOT EXISTS idx_release_manual_tests_release ON release_manual_tests(release_id);
ALTER TABLE release_manual_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_manual_tests FORCE ROW LEVEL SECURITY;
CREATE POLICY release_manual_tests_tenant ON release_manual_tests
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

-- ── Auto-rule columns on checklist items ─────────────────────────────────
-- `auto_rule` names a rule evaluated server-side at GET time; when set, the
-- `checked` column is overridden by the rule result and `auto_details` holds
-- the last human-readable explanation (e.g. "3 failing tests").
ALTER TABLE release_checklist_items
  ADD COLUMN IF NOT EXISTS auto_rule    TEXT;
ALTER TABLE release_checklist_items
  ADD COLUMN IF NOT EXISTS auto_details TEXT;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO flakey_app;
