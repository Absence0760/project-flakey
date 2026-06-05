-- Schema-design audit finding L3: runs.finished_at was TIMESTAMPTZ NOT NULL
-- DEFAULT now(). Live runs (POST /live/start) insert the run row before the
-- suite finishes, so finished_at recorded a meaningless INSERT-time value that
-- was only corrected later on merge. Make it nullable with no default:
-- NULL now means "not yet finished".
--
-- The finish/merge path sets finished_at via GREATEST(finished_at, NOW()), which
-- is NULL-tolerant, so completed runs still get a real timestamp. The live-start
-- INSERT is updated in the same change to stop writing NOW(). Aborted/never-merged
-- live runs now truthfully carry NULL instead of a stale INSERT timestamp.
--
-- ALTER COLUMN DROP NOT NULL / DROP DEFAULT are catalog-only (no table rewrite,
-- no scan). Both are no-ops on re-apply, so the migration is idempotent.
ALTER TABLE runs ALTER COLUMN finished_at DROP NOT NULL;
ALTER TABLE runs ALTER COLUMN finished_at DROP DEFAULT;
