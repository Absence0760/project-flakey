-- Universal notes table: attaches to any entity via target_type + target_key
-- target_type: 'run', 'test', 'error'
-- target_key: run id, test fingerprint (md5(full_title|file_path)), error fingerprint
CREATE TABLE IF NOT EXISTS notes (
  id          SERIAL PRIMARY KEY,
  org_id      INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL,
  target_key  TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notes_target ON notes(org_id, target_type, target_key, created_at);

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notes_tenant ON notes;
CREATE POLICY notes_tenant ON notes
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

-- Migrate existing error_notes into universal notes table.
-- Idempotency: notes has no unique constraint that would conflict on
-- re-insert (the SERIAL PK gets a fresh id each time), so the
-- previous `ON CONFLICT DO NOTHING` was a no-op and the second run
-- of this migration would have duplicated every row. Use the natural
-- key (org_id + target_type + target_key + body + created_at) via
-- WHERE NOT EXISTS so re-applying the migration is safe.
INSERT INTO notes (org_id, user_id, target_type, target_key, body, created_at)
SELECT en.org_id, en.user_id, 'error', eg.fingerprint, en.body, en.created_at
FROM error_notes en
JOIN error_groups eg ON eg.id = en.error_group_id
WHERE NOT EXISTS (
  SELECT 1 FROM notes n
  WHERE n.org_id = en.org_id
    AND n.target_type = 'error'
    AND n.target_key = eg.fingerprint
    AND n.body = en.body
    AND n.created_at = en.created_at
);

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO flakey_app;
