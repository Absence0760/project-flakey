-- Add CHECK constraints to stringly-typed status/type/kind columns that the
-- application already treats as closed enums but the DB did not enforce.
-- Schema-design audit findings H1, M2 (event_type), M3, M4, M5, M6, L5, L8.
--
-- Each value set was confirmed against the route/integration code that writes
-- the column (not the audit comment alone). Seed data was checked to confirm
-- existing rows satisfy every constraint, so these validate cleanly on a
-- populated DB. DROP ... IF EXISTS before ADD keeps the migration idempotent,
-- matching the 007_viewer_role.sql idiom.
--
-- Deliberately NOT constrained here:
--   * live_events.status  — free-form passthrough from reporters (no closed
--     vocabulary server-side); a CHECK would reject whatever a reporter sends.
--   * audit_log.target_type — open-ended developer-chosen string per call site;
--     the seed already writes values ('integration','coverage','retention')
--     that no route emits, so a membership CHECK is neither closed nor safe.

-- H1: error_groups.status (routes/errors.ts VALID_STATUSES)
-- NOTE: 'regressed' was added by migration 068 (Phase 15.2 auto-reopen). It is
-- included HERE too so the whole migration suite stays re-runnable top-to-bottom:
-- migrate.sh re-applies every file each run, and once 068 has widened the
-- constraint and a `regressed` row exists, re-running this DROP+ADD with the old
-- narrow set would fail validation against that row. Keeping the set in lockstep
-- with 068 makes this re-add a no-op widen on a populated DB. 068 remains the
-- canonical definition; edit both together if the enum changes again.
ALTER TABLE error_groups DROP CONSTRAINT IF EXISTS error_groups_status_check;
ALTER TABLE error_groups ADD CONSTRAINT error_groups_status_check
  CHECK (status IN ('open','investigating','known','fixed','ignored','regressed'));

-- M2: live_events.event_type (LiveTestEvent.type union in live-events.ts)
ALTER TABLE live_events DROP CONSTRAINT IF EXISTS live_events_event_type_check;
ALTER TABLE live_events ADD CONSTRAINT live_events_event_type_check
  CHECK (event_type IN (
    'run.started','run.aborted','run.finished',
    'spec.started','spec.finished',
    'test.started','test.passed','test.failed','test.skipped'
  ));

-- M3: webhooks.platform (webhooks.ts formatPayload dispatch)
ALTER TABLE webhooks DROP CONSTRAINT IF EXISTS webhooks_platform_check;
ALTER TABLE webhooks ADD CONSTRAINT webhooks_platform_check
  CHECK (platform IN ('generic','slack','teams','discord'));

-- M4: organizations.git_provider (git-providers/types.ts GitPlatform; nullable)
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_git_provider_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_git_provider_check
  CHECK (git_provider IS NULL OR git_provider IN ('github','gitlab','bitbucket'));

-- M5: organizations.pagerduty_severity (PagerDuty Events API v2; NOT NULL DEFAULT 'error')
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_pagerduty_severity_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_pagerduty_severity_check
  CHECK (pagerduty_severity IN ('critical','error','warning','info'));

-- M6: notes.target_type (routes/notes.ts VALID_TARGET_TYPES)
ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_target_type_check;
ALTER TABLE notes ADD CONSTRAINT notes_target_type_check
  CHECK (target_type IN ('run','test','error'));

-- L5: manual_test_requirements.provider (routes/manual-test-requirements.ts PROVIDERS)
ALTER TABLE manual_test_requirements DROP CONSTRAINT IF EXISTS manual_test_requirements_provider_check;
ALTER TABLE manual_test_requirements ADD CONSTRAINT manual_test_requirements_provider_check
  CHECK (provider IN ('jira','github','linear','other'));

-- L8: organizations integration toggles require their config to be present.
-- The PATCH handlers let auto_create / auto_trigger be toggled independently of
-- the URL/key, so these are genuine new invariants (not redundant with app code).
-- Seed never sets these columns, so all seeded orgs short-circuit on the false flag.
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_jira_autocreate_requires_url_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_jira_autocreate_requires_url_check
  CHECK (NOT jira_auto_create OR jira_base_url IS NOT NULL);

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_pagerduty_autotrigger_requires_key_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_pagerduty_autotrigger_requires_key_check
  CHECK (NOT pagerduty_auto_trigger OR pagerduty_integration_key IS NOT NULL);
