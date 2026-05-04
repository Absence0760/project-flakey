-- Track which target environment a run executed against (e.g. "qa",
-- "stage", "prod"). Reporters surface it via meta.environment on the
-- upload payload; the dashboard surfaces it as a header chip and a
-- filter dropdown on the runs grid.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT '';

-- Distinct-environment lookups (for the filter dropdown) and equality
-- filtering both benefit from a plain b-tree on the column.
CREATE INDEX IF NOT EXISTS idx_runs_environment ON runs(environment);
