-- Per-execution history for manual tests.
--
-- Previously only manual_tests.last_run_at / last_run_by / status recorded
-- the most recent execution, so repeat runs of the same test could not be
-- counted. This table records every ad-hoc execution (outside the formal
-- release-session flow, which already has its own history in
-- release_test_session_results). Rows here are never updated — each run
-- is append-only.

CREATE TABLE IF NOT EXISTS manual_test_runs (
  id              SERIAL PRIMARY KEY,
  org_id          INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  manual_test_id  INT NOT NULL REFERENCES manual_tests(id) ON DELETE CASCADE,
  status          TEXT NOT NULL
                   CHECK (status IN ('passed','failed','blocked','skipped')),
  notes           TEXT,
  step_results    JSONB NOT NULL DEFAULT '[]'::jsonb,
  run_by          INT REFERENCES users(id) ON DELETE SET NULL,
  run_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_manual_test_runs_test ON manual_test_runs(manual_test_id, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_manual_test_runs_org_time ON manual_test_runs(org_id, run_at DESC);
ALTER TABLE manual_test_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_test_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY manual_test_runs_tenant ON manual_test_runs
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO flakey_app;
