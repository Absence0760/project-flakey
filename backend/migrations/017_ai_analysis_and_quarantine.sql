-- AI analysis cache
CREATE TABLE IF NOT EXISTS ai_analyses (
  id SERIAL PRIMARY KEY,
  org_id INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_key TEXT NOT NULL,
  classification TEXT,
  summary TEXT,
  suggested_fix TEXT,
  confidence NUMERIC(3,2),
  raw_result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, target_type, target_key)
);

ALTER TABLE ai_analyses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_analyses_org_isolation ON ai_analyses;
CREATE POLICY ai_analyses_org_isolation ON ai_analyses
  USING (org_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (org_id::text = current_setting('app.current_org_id', true));

-- Flaky test quarantine
CREATE TABLE IF NOT EXISTS quarantined_tests (
  id SERIAL PRIMARY KEY,
  org_id INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  full_title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  suite_name TEXT NOT NULL,
  reason TEXT,
  quarantined_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, full_title, suite_name)
);

CREATE INDEX IF NOT EXISTS idx_quarantined_tests_org ON quarantined_tests(org_id);
CREATE INDEX IF NOT EXISTS idx_quarantined_tests_suite ON quarantined_tests(suite_name);

ALTER TABLE quarantined_tests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS quarantined_tests_org_isolation ON quarantined_tests;
CREATE POLICY quarantined_tests_org_isolation ON quarantined_tests
  USING (org_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (org_id::text = current_setting('app.current_org_id', true));
