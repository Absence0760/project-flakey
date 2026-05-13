-- Normalise the four legacy RLS policies (saved_views, ai_analyses,
-- quarantined_tests, live_events) to the canonical
--   org_id = current_setting('app.current_org_id', true)::int
-- comparison form.
--
-- The original policies in 016/017/018 were written as
--   org_id::text = current_setting('app.current_org_id', true)
-- which works (NULL on missing setting fails-safe under both casts)
-- but is inconsistent with every other tenant table's policy. The
-- inconsistency makes audit harder and lets a future copy-paste of
-- the wrong form drift further. Standardise everything on one shape.

DROP POLICY IF EXISTS saved_views_tenant ON saved_views;
CREATE POLICY saved_views_tenant ON saved_views
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

DROP POLICY IF EXISTS ai_analyses_tenant ON ai_analyses;
CREATE POLICY ai_analyses_tenant ON ai_analyses
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

DROP POLICY IF EXISTS quarantined_tests_tenant ON quarantined_tests;
CREATE POLICY quarantined_tests_tenant ON quarantined_tests
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

DROP POLICY IF EXISTS live_events_tenant ON live_events;
CREATE POLICY live_events_tenant ON live_events
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);
