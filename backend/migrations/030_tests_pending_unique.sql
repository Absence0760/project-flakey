-- Live-event uniqueness fences.
--
-- Two concurrent test.started events for the same spec/test can race past
-- app-level SELECT+INSERT guards. These indexes let the DB reject the
-- duplicates atomically so the live path is safe even under load.
--
-- Drop indexes first so the dedupe blocks below can reassign/delete rows
-- without tripping a partial-unique constraint mid-migration. They're
-- recreated at the bottom.

DROP INDEX IF EXISTS idx_tests_pending_unique;
DROP INDEX IF EXISTS uniq_specs_run_file;

-- Live path creates at most one specs row per (run_id, file_path).
-- /uploads creates fresh spec rows per run and should never conflict
-- (different run_ids); the constraint therefore costs nothing there.
--
-- Prior to this migration, concurrent test.started events could race past
-- findOrCreateSpec's SELECT+INSERT and produce duplicate spec rows. Clean
-- those up by reassigning any orphaned test rows to the oldest spec id for
-- each (run_id, file_path), then delete the duplicate spec rows so the
-- unique index below can be created.
WITH canonical AS (
  SELECT DISTINCT ON (run_id, file_path) run_id, file_path, id AS canonical_id
  FROM specs
  ORDER BY run_id, file_path, id
),
dupes AS (
  SELECT s.id AS dup_id, c.canonical_id
  FROM specs s
  JOIN canonical c ON c.run_id = s.run_id AND c.file_path = s.file_path
  WHERE s.id <> c.canonical_id
)
UPDATE tests t SET spec_id = d.canonical_id
FROM dupes d WHERE t.spec_id = d.dup_id;

DELETE FROM specs s WHERE EXISTS (
  SELECT 1 FROM specs o
  WHERE o.run_id = s.run_id AND o.file_path = s.file_path AND o.id < s.id
);

-- Reassignment above may have merged multiple pending rows into the same
-- canonical spec. Keep the oldest pending row per (spec_id, full_title);
-- delete the rest so the partial unique index below is creatable.
DELETE FROM tests t
WHERE t.status = 'pending' AND EXISTS (
  SELECT 1 FROM tests o
  WHERE o.status = 'pending'
    AND o.spec_id = t.spec_id
    AND o.full_title = t.full_title
    AND o.id < t.id
);

-- A non-unique index with this shape already exists (migration 020
-- `idx_specs_run_file`). We need a *unique* index for ON CONFLICT
-- inference, so add a differently-named unique one alongside it.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_specs_run_file
  ON specs (run_id, file_path);

-- Live path keeps at most one pending row per (spec_id, full_title).
-- After transition to passed/failed/skipped the partial predicate no
-- longer matches, which is intentional: retries and the normal upload
-- flow may legitimately produce multiple non-pending rows per tuple.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tests_pending_unique
  ON tests (spec_id, full_title)
  WHERE status = 'pending';
