-- Enforce at the database level that only one in_progress session can exist
-- per release at a time, eliminating the TOCTOU race in the route handler.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_release_one_active_session
  ON release_test_sessions (release_id)
  WHERE status = 'in_progress';
