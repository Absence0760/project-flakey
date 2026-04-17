-- UX uplift for manual testing & releases:
--  • Requirements traceability — link a manual test to stories/tickets in
--    Jira/GitHub/Linear so release readiness can show story coverage.
--  • Step/result evidence — attach screenshots or files to a recorded
--    session result. Stored as a JSONB array of { key, filename, size }.
--  • Per-test assignment — lets a QA lead divide a session across testers.
--  • Session scheduling — a target date (and assignee) per session so the
--    dashboard can show who's due to execute what and when.

-- ── Requirements ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS manual_test_requirements (
  id              SERIAL PRIMARY KEY,
  org_id          INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  manual_test_id  INT NOT NULL REFERENCES manual_tests(id) ON DELETE CASCADE,
  -- Short identifier (e.g. ABC-123, gh#42). Free-form so we don't lock users
  -- into a single provider.
  ref_key         TEXT NOT NULL,
  ref_url         TEXT,
  ref_title       TEXT,
  -- 'jira' | 'github' | 'linear' | 'other'
  provider        TEXT NOT NULL DEFAULT 'other',
  added_by        INT REFERENCES users(id) ON DELETE SET NULL,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (manual_test_id, ref_key)
);
CREATE INDEX IF NOT EXISTS idx_manual_test_requirements_org
  ON manual_test_requirements(org_id);
CREATE INDEX IF NOT EXISTS idx_manual_test_requirements_test
  ON manual_test_requirements(manual_test_id);
ALTER TABLE manual_test_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_test_requirements FORCE ROW LEVEL SECURITY;
CREATE POLICY manual_test_requirements_tenant ON manual_test_requirements
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

-- ── Per-result evidence + assignment ────────────────────────────────────
ALTER TABLE release_test_session_results
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS assigned_to INT REFERENCES users(id) ON DELETE SET NULL,
  -- The Jira (or future GH/Linear) issue this result filed as the
  -- known-issue. Separate from known_issue_ref so we can display a badge
  -- even when the ref hasn't been set yet.
  ADD COLUMN IF NOT EXISTS filed_bug_key TEXT,
  ADD COLUMN IF NOT EXISTS filed_bug_url TEXT;

-- ── Session target date (for scheduling panels) ─────────────────────────
ALTER TABLE release_test_sessions
  ADD COLUMN IF NOT EXISTS target_date DATE;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO flakey_app;
