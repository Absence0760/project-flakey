-- Error groups: persisted status and metadata for recurring errors
-- fingerprint = md5(error_message || test_title || suite_name) for stable identity
CREATE TABLE IF NOT EXISTS error_groups (
  id          SERIAL PRIMARY KEY,
  org_id      INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',  -- open, investigating, known, fixed, ignored
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_error_groups_org ON error_groups(org_id);

ALTER TABLE error_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE error_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY error_groups_tenant ON error_groups
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

-- Error notes: threaded discussion on error groups
CREATE TABLE IF NOT EXISTS error_notes (
  id             SERIAL PRIMARY KEY,
  error_group_id INT NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  org_id         INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id        INT REFERENCES users(id) ON DELETE SET NULL,
  body           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_error_notes_group ON error_notes(error_group_id, created_at);

ALTER TABLE error_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE error_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY error_notes_tenant ON error_notes
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO flakey_app;
