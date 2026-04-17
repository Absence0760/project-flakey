-- Xray-style "accept failure as known issue": lets a release ship with a
-- failing or blocked test on record, provided someone explicitly defers it
-- against a tracked bug. Accepted results stop counting as blockers and
-- drop out of the next failures-only rerun.

ALTER TABLE release_test_session_results
  ADD COLUMN IF NOT EXISTS accepted_as_known_issue BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS known_issue_ref TEXT,
  ADD COLUMN IF NOT EXISTS accepted_by INT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_session_results_accepted
  ON release_test_session_results(session_id)
  WHERE accepted_as_known_issue = TRUE;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
