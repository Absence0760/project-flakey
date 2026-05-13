-- Clean up the orphaned `*_org_isolation` policies left behind by 042.
--
-- Migration 042 introduced canonical `*_tenant` policies on saved_views,
-- ai_analyses, quarantined_tests, and live_events, but did not drop the
-- original `*_org_isolation` policies created in 016/017/018. The result
-- is two PERMISSIVE policies per table: both have equivalent
-- org_id-equality predicates (one cast `::text`, one `::int`), so a row
-- passes if either matches. There is no current cross-org read because
-- both predicates are semantically identical, but:
--   - `pg_policies` shows two rows per table, making audit by inspection
--     misleading (the "one tenant-policy per table" invariant cannot be
--     verified without manual classification).
--   - A future edit to the `*_tenant` policy leaves the
--     `*_org_isolation` form silently active, allowing the two policies
--     to drift apart unnoticed.
--   - Migration 038 (FORCE ROW LEVEL SECURITY) claims a clean state for
--     these tables that doesn't actually exist.
--
-- DROP IF EXISTS so the migration is safe to re-run.

DROP POLICY IF EXISTS saved_views_org_isolation ON saved_views;
DROP POLICY IF EXISTS ai_analyses_org_isolation ON ai_analyses;
DROP POLICY IF EXISTS quarantined_tests_org_isolation ON quarantined_tests;
DROP POLICY IF EXISTS live_events_org_isolation ON live_events;
