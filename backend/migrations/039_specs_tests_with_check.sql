-- Add explicit WITH CHECK to the specs and tests RLS policies.
--
-- The original policies in 004_multi_tenancy.sql were defined with USING only:
--   CREATE POLICY specs_tenant_isolation ON specs USING (run_id IN (SELECT id FROM runs));
--   CREATE POLICY tests_tenant_isolation ON tests USING (spec_id IN (SELECT id FROM specs));
--
-- Postgres applies USING for INSERT/UPDATE writes when WITH CHECK is omitted,
-- which means today the chain-join subquery is the write guard too — and it
-- works only because the *runs* policy correctly scopes its subquery by
-- `app.current_org_id`. A future regression on the runs policy (e.g. a
-- temporarily-permissive policy during a migration, or a SECURITY DEFINER
-- function that loosens scope) would silently let one org write specs/tests
-- under another org's runs.
--
-- Mirror USING explicitly into WITH CHECK so the write guard is independent
-- of whatever the runs policy happens to be at any moment.

DROP POLICY IF EXISTS specs_tenant_isolation ON specs;
CREATE POLICY specs_tenant_isolation ON specs
  USING (run_id IN (SELECT id FROM runs))
  WITH CHECK (run_id IN (SELECT id FROM runs));

DROP POLICY IF EXISTS tests_tenant_isolation ON tests;
CREATE POLICY tests_tenant_isolation ON tests
  USING (spec_id IN (SELECT id FROM specs))
  WITH CHECK (spec_id IN (SELECT id FROM specs));
