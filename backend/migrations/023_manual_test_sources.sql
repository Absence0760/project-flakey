-- Dual-source manual tests:
--   source = 'manual'   → hand-authored via the UI (existing behaviour)
--   source = 'cucumber' → imported from a .feature file, with source_ref as
--                          the stable identity used for upsert on re-import.

ALTER TABLE manual_tests
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','cucumber'));

ALTER TABLE manual_tests
  ADD COLUMN IF NOT EXISTS source_ref TEXT;

ALTER TABLE manual_tests
  ADD COLUMN IF NOT EXISTS source_file TEXT;

-- Identity for re-import: (org, source, source_ref) uniquely identifies an
-- imported scenario. Partial so hand-authored rows (source_ref NULL) don't
-- collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS manual_tests_source_ref_key
  ON manual_tests (org_id, source, source_ref)
  WHERE source_ref IS NOT NULL;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
