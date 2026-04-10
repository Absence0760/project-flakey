-- Link a Flakey release to a Jira version so we can show "what's shipping"
-- from the tracker side-by-side with test readiness. Matching is done by
-- version string when first requested, and the result is cached on the
-- release row so subsequent loads don't re-search Jira.

ALTER TABLE releases
  ADD COLUMN IF NOT EXISTS jira_version_id   TEXT;
ALTER TABLE releases
  ADD COLUMN IF NOT EXISTS jira_version_name TEXT;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
