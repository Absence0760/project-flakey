# Migrations

Better Testing uses plain SQL migration files in `backend/migrations/`. They are numbered sequentially (`001_initial.sql`, `002_test_artifacts.sql`, etc.) and run in order.

## When migrations run automatically

On a **fresh database**, Docker handles everything. The `docker-compose.yml` mounts `backend/migrations/` to `/docker-entrypoint-initdb.d`, so PostgreSQL runs all `.sql` files on first startup.

```bash
docker compose up -d
```

This only happens once — when the `pgdata` volume is first created.

## When you need to run migrations manually

If you **already have a running database** and pull new code with new migration files, you need to apply them yourself. This happens when:

- You pull changes that include new migrations
- You're upgrading an existing installation
- You added a migration during development

## Running migrations

### Option 1: Migration script (recommended)

```bash
./backend/migrate.sh
```

The script runs all migration files in order. It's safe to re-run — migrations use `IF NOT EXISTS` and `IF NOT EXISTS` guards so already-applied migrations are skipped.

Override connection settings with environment variables:

```bash
DB_HOST=myhost DB_USER=myuser DB_PASSWORD=secret DB_NAME=flakey ./backend/migrate.sh
```

### Option 2: Run a specific migration

```bash
PGPASSWORD=flakey psql -h localhost -U flakey -d flakey -f backend/migrations/013_error_tracking.sql
```

### Option 3: Reset the database entirely

This destroys all data and re-runs everything from scratch:

```bash
docker compose down -v   # removes the pgdata volume
docker compose up -d     # recreates and runs all migrations
npm run seed             # optional: re-seed sample data
```

## Writing new migrations

1. Create a new file: `backend/migrations/NNN_description.sql`
2. Use `IF NOT EXISTS` / `IF NOT EXISTS` guards so the migration is idempotent
3. If adding tables with Row-Level Security, include:
   - `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`
   - A tenant policy using `current_setting('app.current_org_id', true)::int`
   - `GRANT ALL PRIVILEGES` to the `flakey_app` role
4. Test by running `./backend/migrate.sh`

### Example

```sql
CREATE TABLE IF NOT EXISTS my_table (
  id      SERIAL PRIMARY KEY,
  org_id  INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name    TEXT NOT NULL
);

ALTER TABLE my_table ENABLE ROW LEVEL SECURITY;
ALTER TABLE my_table FORCE ROW LEVEL SECURITY;
CREATE POLICY my_table_tenant ON my_table
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO flakey_app;
```

## Current migrations

| File | Description |
|------|-------------|
| `001_initial.sql` | Runs, specs, tests tables |
| `002_test_artifacts.sql` | Screenshot/video paths |
| `003_auth.sql` | Users, API keys, default admin |
| `004_multi_tenancy.sql` | Organizations, org members, RLS policies |
| `005_app_role.sql` | Non-superuser `flakey_app` role for RLS |
| `006_test_metadata.sql` | Test metadata JSONB column |
| `007_viewer_role.sql` | Viewer role, invites |
| `008_admin_features.sql` | Audit log, suite overrides, retention, webhooks |
| `009_snapshot_path.sql` | DOM snapshot column |
| `010_webhook_platform.sql` | Webhook platform column (Slack/Teams/Discord) |
| `011_github_integration.sql` | GitHub token/repo on organizations |
| `012_git_provider.sql` | Generic git provider (GitHub/GitLab/Bitbucket) |
| `013_error_tracking.sql` | Error groups with status, error notes |
| `014_universal_notes.sql` | Universal notes table for runs, tests, and errors |
| `015_email_verification_and_password_reset.sql` | Email verification and password reset columns on users |
| `016_saved_views.sql` | Saved filter views with RLS |
| `017_ai_analysis_and_quarantine.sql` | AI analysis cache and flaky test quarantine tables |
| `018_live_events.sql` | Live test event persistence for real-time progress |
| `019_rerun_command_template.sql` | Per-suite rerun command template on suite_overrides |
| `020_performance_indexes.sql` | Composite indexes for multi-tenant query performance |
| `021_default_retention.sql` | Default 7-day data retention policy |
| `022_phase_9_10.sql` | Jira + PagerDuty integrations, scheduled reports, code coverage, accessibility reports, visual regression diffs, UI coverage mapping, manual test management, and release checklists |
| `023_manual_test_sources.sql` | Adds `source`, `source_ref`, `source_file` columns to `manual_tests` so hand-authored and Cucumber-imported scenarios can coexist, with a unique partial index on `(org_id, source, source_ref)` enforcing idempotent re-imports |
| `024_manual_test_step_results.sql` | `last_step_results` JSONB column on `manual_tests` so the step-by-step runner can persist per-step pass/fail state |
| `025_release_links.sql` | `release_runs` and `release_manual_tests` link tables pinning automated runs and manual tests to a release, plus `auto_rule` / `auto_details` columns on `release_checklist_items` for server-evaluated checklist rules |
| `026_release_jira_version.sql` | `jira_version_id` / `jira_version_name` columns on `releases` pinning a Jira fix version to the release |
| `027_manual_test_groups_and_sessions.sql` | `manual_test_groups` (named collections of manual tests), `group_id` on `manual_tests`, plus `release_test_sessions` and `release_test_session_results` for Xray-style test plan / execution cycles |
| `028_release_test_result_accepted.sql` | Adds `accepted_as_known_issue`, `known_issue_ref`, `accepted_by`, `accepted_at` to `release_test_session_results` so a failed/blocked result can be explicitly deferred against a bug and stop blocking the release |
| `029_traceability_evidence_assignees.sql` | `manual_test_requirements` (link a manual test to Jira/GitHub/Linear stories for coverage rollups), plus `attachments` / `assigned_to` / `filed_bug_key` / `filed_bug_url` on `release_test_session_results` and `target_date` on `release_test_sessions` |
