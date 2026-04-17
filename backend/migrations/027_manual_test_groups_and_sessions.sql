-- Manual test groups: named collections of tests that can be bulk-added
-- to a release in one operation.
--
-- Release test sessions: one test-run attempt per release. Instead of a
-- single flat status on release_manual_tests, each session seeds its own
-- result rows so the full run history is preserved and failures-only
-- re-runs are straightforward.

-- ── Manual test groups ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS manual_test_groups (
  id          SERIAL PRIMARY KEY,
  org_id      INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_by  INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, name)
);
CREATE INDEX IF NOT EXISTS idx_manual_test_groups_org ON manual_test_groups(org_id);
ALTER TABLE manual_test_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_test_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY manual_test_groups_tenant ON manual_test_groups
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

-- ── Extend manual_tests with optional group membership ───────────────────
ALTER TABLE manual_tests
  ADD COLUMN IF NOT EXISTS group_id INT REFERENCES manual_test_groups(id) ON DELETE SET NULL;

-- ── Release test sessions ─────────────────────────────────────────────────
-- Each session is one run attempt for a release (full or failures-only re-run).
CREATE TABLE IF NOT EXISTS release_test_sessions (
  id              SERIAL PRIMARY KEY,
  org_id          INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  release_id      INT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  session_number  INT NOT NULL,
  label           TEXT,
  mode            TEXT NOT NULL DEFAULT 'full'
                   CHECK (mode IN ('full', 'failures_only')),
  status          TEXT NOT NULL DEFAULT 'in_progress'
                   CHECK (status IN ('in_progress', 'completed')),
  created_by      INT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  UNIQUE (release_id, session_number)
);
CREATE INDEX IF NOT EXISTS idx_release_test_sessions_release ON release_test_sessions(release_id);
ALTER TABLE release_test_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_test_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY release_test_sessions_tenant ON release_test_sessions
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

-- ── Per-test results within a session ────────────────────────────────────
-- Rows are pre-seeded at session creation (status = 'not_run') for every
-- test in scope, making progress counting trivial.
CREATE TABLE IF NOT EXISTS release_test_session_results (
  id              SERIAL PRIMARY KEY,
  org_id          INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id      INT NOT NULL REFERENCES release_test_sessions(id) ON DELETE CASCADE,
  manual_test_id  INT NOT NULL REFERENCES manual_tests(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'not_run'
                   CHECK (status IN ('not_run', 'passed', 'failed', 'blocked', 'skipped')),
  notes           TEXT,
  step_results    JSONB NOT NULL DEFAULT '[]'::jsonb,
  run_by          INT REFERENCES users(id) ON DELETE SET NULL,
  run_at          TIMESTAMPTZ,
  UNIQUE (session_id, manual_test_id)
);
CREATE INDEX IF NOT EXISTS idx_session_results_session ON release_test_session_results(session_id);
CREATE INDEX IF NOT EXISTS idx_session_results_status ON release_test_session_results(session_id, status);
ALTER TABLE release_test_session_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_test_session_results FORCE ROW LEVEL SECURITY;
CREATE POLICY release_test_session_results_tenant ON release_test_session_results
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO flakey_app;
