-- Composite indexes for multi-tenant queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_org_created ON runs(org_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_suite_org_id ON runs(suite_name, org_id, id DESC);

-- Tests table indexes for status filtering and error lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tests_status ON tests(status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tests_full_title ON tests(full_title);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tests_failed_error ON tests(spec_id) WHERE status = 'failed' AND error_message IS NOT NULL;

-- Specs run_id + file_path for joins
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_specs_run_file ON specs(run_id, file_path);
