CREATE TABLE IF NOT EXISTS saved_views (
  id SERIAL PRIMARY KEY,
  org_id INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  page TEXT NOT NULL DEFAULT 'runs',
  filters JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_views_org ON saved_views(org_id);
CREATE INDEX IF NOT EXISTS idx_saved_views_user ON saved_views(user_id);

-- RLS policy
ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saved_views_org_isolation ON saved_views;
CREATE POLICY saved_views_org_isolation ON saved_views
  USING (org_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (org_id::text = current_setting('app.current_org_id', true));
