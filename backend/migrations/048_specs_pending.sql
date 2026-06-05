-- Schema-design audit finding M7: the specs rollup lacked a `pending` column
-- even though runs has one. Worse, the normalizers folded pending tests into
-- specs.skipped, so specs.skipped was actually skipped+pending (an overlapping
-- count) — diverging from how runs tracks the two separately and silently
-- breaking the passed+failed+skipped+pending = total invariant at the spec level.
--
-- This migration adds specs.pending and re-derives BOTH specs.pending and
-- specs.skipped from the tests table so they are disjoint. The application code
-- (normalizers + live recompute) is updated in the same change to keep them
-- disjoint going forward; this backfill repairs existing rows. runs.skipped is
-- re-derived from the now-pure specs.skipped (runs.pending was already correct,
-- sourced directly from tests).
--
-- ADD COLUMN ... DEFAULT 0 is metadata-only on Postgres 11+ (no table rewrite).

ALTER TABLE specs ADD COLUMN IF NOT EXISTS pending INT NOT NULL DEFAULT 0;

-- Backfill disjoint pending/skipped from the source-of-truth tests rows.
UPDATE specs s SET
  pending = COALESCE(c.pending, 0),
  skipped = COALESCE(c.skipped, 0)
FROM (
  SELECT spec_id,
         COUNT(*) FILTER (WHERE status = 'pending') AS pending,
         COUNT(*) FILTER (WHERE status = 'skipped') AS skipped
  FROM tests
  GROUP BY spec_id
) c
WHERE c.spec_id = s.id;

-- Re-derive runs.skipped from the now-pure specs.skipped so the run rollup matches.
UPDATE runs r SET
  skipped = COALESCE((SELECT SUM(s.skipped) FROM specs s WHERE s.run_id = r.id), 0);
