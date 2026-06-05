-- Schema-design audit finding M8: webhooks and suite_overrides are mutable
-- entities (changed by PATCH routes) but carried only created_at. Add updated_at.
--
-- Kept current app-side (the PATCH/UPSERT handlers now set updated_at = NOW()),
-- matching the rest of the schema — error_groups, releases, and the manual-test
-- tables all maintain updated_at in application code; there are no triggers in
-- this database and introducing the first one for two tables would diverge from
-- the established convention.
--
-- ADD COLUMN ... DEFAULT NOW() is metadata-only on Postgres 11+ (no rewrite);
-- existing rows get the apply timestamp, which is acceptable for a first value.

ALTER TABLE webhooks        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE suite_overrides ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
