-- Force RLS on the four pre-FORCE tables.
--
-- ENABLE ROW LEVEL SECURITY exempts table owners from policy
-- enforcement. The migrate.sh runner connects as the schema owner, so
-- a stray query in a migration or a future ad-hoc admin connection
-- could see/modify rows across orgs unchallenged. FORCE applies the
-- policy to owners too — closing the only path past tenantQuery's
-- per-statement `app.current_org` predicate.
--
-- All four tables already have org_id-scoped policies; this is the
-- gate that ensures those policies actually run for every connection.
-- Same fix already applied to the post-013 tables (008, 013, 022,
-- 025, etc.); these four were missed.

ALTER TABLE saved_views        FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_analyses        FORCE ROW LEVEL SECURITY;
ALTER TABLE quarantined_tests  FORCE ROW LEVEL SECURITY;
ALTER TABLE live_events        FORCE ROW LEVEL SECURITY;
