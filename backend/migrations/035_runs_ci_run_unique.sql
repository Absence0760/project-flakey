-- Race fix for the parallel-CI merge guarantee.
--
-- findOrCreateRun in run-merge.ts did `SELECT ... THEN INSERT` without
-- a unique constraint or upsert.  Two CI workers POSTing simultaneously
-- could each see "no existing row" and each INSERT, producing two run
-- rows for the same ci_run_id — breaking the merge guarantee that the
-- product is built around (the whole reason it exists vs Cypress Cloud).
--
-- Partial index because the empty-string ci_run_id (used by /runs
-- uploads that don't supply CI metadata) is intentionally not unique —
-- two unrelated runs both with ci_run_id='' must remain distinct.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_runs_ci_run
  ON runs (org_id, suite_name, ci_run_id)
  WHERE ci_run_id <> '';
