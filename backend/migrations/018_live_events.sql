CREATE TABLE IF NOT EXISTS live_events (
  id SERIAL PRIMARY KEY,
  run_id INT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  org_id INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  spec TEXT,
  test TEXT,
  status TEXT,
  duration_ms INT,
  error_message TEXT,
  stats JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_live_events_run ON live_events(run_id);

ALTER TABLE live_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS live_events_org_isolation ON live_events;
CREATE POLICY live_events_org_isolation ON live_events
  USING (org_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (org_id::text = current_setting('app.current_org_id', true));
