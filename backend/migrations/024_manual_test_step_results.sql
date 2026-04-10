-- Per-step results from the most recent manual test run.
-- Stored inline as a JSON array of { status, comment } entries, indexed to
-- match the corresponding position in `steps`. Overwritten on every run —
-- we only keep the latest execution.

ALTER TABLE manual_tests
  ADD COLUMN IF NOT EXISTS last_step_results JSONB NOT NULL DEFAULT '[]'::jsonb;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
