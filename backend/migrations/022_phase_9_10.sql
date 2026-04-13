-- Phase 9 + 10 roadmap features:
--   Jira + PagerDuty integrations (org settings columns)
--   Scheduled reports
--   Code coverage + PR gating
--   Accessibility testing results
--   Visual regression diffs
--   UI coverage mapping
--   Manual test management
--   Release checklists + sign-off

-- ── Jira integration (per-org settings) ────────────────────────────────────
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS jira_base_url TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS jira_email TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS jira_api_token TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS jira_project_key TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS jira_auto_create BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS jira_issue_type TEXT NOT NULL DEFAULT 'Bug';

-- ── PagerDuty integration ─────────────────────────────────────────────────
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS pagerduty_integration_key TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS pagerduty_auto_trigger BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS pagerduty_severity TEXT NOT NULL DEFAULT 'error';

-- ── Code coverage PR gating threshold ─────────────────────────────────────
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS coverage_threshold NUMERIC(5,2);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS coverage_gate_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- ── Failure → Jira issue tracking (dedupe) ────────────────────────────────
CREATE TABLE IF NOT EXISTS failure_jira_issues (
  id         SERIAL PRIMARY KEY,
  org_id     INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  issue_key  TEXT NOT NULL,
  issue_url  TEXT NOT NULL,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_failure_jira_org ON failure_jira_issues(org_id);
ALTER TABLE failure_jira_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE failure_jira_issues FORCE ROW LEVEL SECURITY;
CREATE POLICY failure_jira_issues_tenant ON failure_jira_issues
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

-- ── Scheduled reports ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduled_reports (
  id           SERIAL PRIMARY KEY,
  org_id       INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  cadence      TEXT NOT NULL CHECK (cadence IN ('daily','weekly')),
  day_of_week  INT CHECK (day_of_week BETWEEN 0 AND 6),
  hour_utc     INT NOT NULL DEFAULT 9 CHECK (hour_utc BETWEEN 0 AND 23),
  channel      TEXT NOT NULL CHECK (channel IN ('email','webhook','slack')),
  destination  TEXT NOT NULL,
  suite_filter TEXT,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_sent_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_org ON scheduled_reports(org_id);
ALTER TABLE scheduled_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_reports_tenant ON scheduled_reports
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

-- ── Code coverage reports ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coverage_reports (
  id              SERIAL PRIMARY KEY,
  org_id          INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id          INT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  lines_pct       NUMERIC(5,2),
  branches_pct    NUMERIC(5,2),
  functions_pct   NUMERIC(5,2),
  statements_pct  NUMERIC(5,2),
  lines_covered   INT,
  lines_total     INT,
  files           JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(run_id)
);
CREATE INDEX IF NOT EXISTS idx_coverage_org ON coverage_reports(org_id, created_at DESC);
ALTER TABLE coverage_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE coverage_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY coverage_reports_tenant ON coverage_reports
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

-- ── Accessibility reports ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS a11y_reports (
  id               SERIAL PRIMARY KEY,
  org_id           INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id           INT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  url              TEXT,
  score            NUMERIC(5,2),
  violations_count INT NOT NULL DEFAULT 0,
  violations       JSONB,
  passes_count     INT NOT NULL DEFAULT 0,
  incomplete_count INT NOT NULL DEFAULT 0,
  critical_count   INT NOT NULL DEFAULT 0,
  serious_count    INT NOT NULL DEFAULT 0,
  moderate_count   INT NOT NULL DEFAULT 0,
  minor_count      INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_a11y_run ON a11y_reports(run_id);
CREATE INDEX IF NOT EXISTS idx_a11y_org_created ON a11y_reports(org_id, created_at DESC);
ALTER TABLE a11y_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE a11y_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY a11y_reports_tenant ON a11y_reports
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

-- ── Visual regression diffs ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS visual_diffs (
  id             SERIAL PRIMARY KEY,
  org_id         INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id         INT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  test_id        INT REFERENCES tests(id) ON DELETE SET NULL,
  name           TEXT NOT NULL,
  baseline_path  TEXT,
  current_path   TEXT,
  diff_path      TEXT,
  diff_pct       NUMERIC(6,3),
  status         TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','changed','new','unchanged')),
  reviewed_by    INT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_visual_diffs_run ON visual_diffs(run_id);
CREATE INDEX IF NOT EXISTS idx_visual_diffs_org ON visual_diffs(org_id, created_at DESC);
ALTER TABLE visual_diffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE visual_diffs FORCE ROW LEVEL SECURITY;
CREATE POLICY visual_diffs_tenant ON visual_diffs
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

-- ── UI coverage: routes visited by tests ──────────────────────────────────
CREATE TABLE IF NOT EXISTS ui_coverage (
  id             SERIAL PRIMARY KEY,
  org_id         INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  suite_name     TEXT NOT NULL,
  route_pattern  TEXT NOT NULL,
  visit_count    INT NOT NULL DEFAULT 1,
  first_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_run_id    INT REFERENCES runs(id) ON DELETE SET NULL,
  UNIQUE(org_id, suite_name, route_pattern)
);
CREATE INDEX IF NOT EXISTS idx_ui_coverage_org ON ui_coverage(org_id, last_seen DESC);
ALTER TABLE ui_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ui_coverage FORCE ROW LEVEL SECURITY;
CREATE POLICY ui_coverage_tenant ON ui_coverage
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

-- ── UI known routes: the complete route inventory ────────────────────────
CREATE TABLE IF NOT EXISTS ui_known_routes (
  id             SERIAL PRIMARY KEY,
  org_id         INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  route_pattern  TEXT NOT NULL,
  label          TEXT,
  source         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, route_pattern)
);
ALTER TABLE ui_known_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ui_known_routes FORCE ROW LEVEL SECURITY;
CREATE POLICY ui_known_routes_tenant ON ui_known_routes
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

-- ── Manual test management ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS manual_tests (
  id                  SERIAL PRIMARY KEY,
  org_id              INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  suite_name          TEXT,
  title               TEXT NOT NULL,
  description         TEXT,
  steps               JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_result     TEXT,
  priority            TEXT NOT NULL DEFAULT 'medium'
                       CHECK (priority IN ('low','medium','high','critical')),
  status              TEXT NOT NULL DEFAULT 'not_run'
                       CHECK (status IN ('not_run','passed','failed','blocked','skipped')),
  last_run_at         TIMESTAMPTZ,
  last_run_by         INT REFERENCES users(id) ON DELETE SET NULL,
  last_run_notes      TEXT,
  automated_test_key  TEXT,
  tags                TEXT[] NOT NULL DEFAULT '{}',
  created_by          INT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_manual_tests_org ON manual_tests(org_id);
CREATE INDEX IF NOT EXISTS idx_manual_tests_status ON manual_tests(org_id, status);
ALTER TABLE manual_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_tests FORCE ROW LEVEL SECURITY;
CREATE POLICY manual_tests_tenant ON manual_tests
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

-- ── Releases + checklist items ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS releases (
  id             SERIAL PRIMARY KEY,
  org_id         INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version        TEXT NOT NULL,
  name           TEXT,
  status         TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','in_progress','signed_off','released','cancelled')),
  target_date    DATE,
  description    TEXT,
  signed_off_by  INT REFERENCES users(id) ON DELETE SET NULL,
  signed_off_at  TIMESTAMPTZ,
  created_by     INT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, version)
);
CREATE INDEX IF NOT EXISTS idx_releases_org ON releases(org_id, created_at DESC);
ALTER TABLE releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE releases FORCE ROW LEVEL SECURITY;
CREATE POLICY releases_tenant ON releases
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

CREATE TABLE IF NOT EXISTS release_checklist_items (
  id           SERIAL PRIMARY KEY,
  org_id       INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  release_id   INT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  required     BOOLEAN NOT NULL DEFAULT TRUE,
  checked      BOOLEAN NOT NULL DEFAULT FALSE,
  checked_by   INT REFERENCES users(id) ON DELETE SET NULL,
  checked_at   TIMESTAMPTZ,
  position     INT NOT NULL DEFAULT 0,
  notes        TEXT
);
CREATE INDEX IF NOT EXISTS idx_checklist_release ON release_checklist_items(release_id);
ALTER TABLE release_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_checklist_items FORCE ROW LEVEL SECURITY;
CREATE POLICY release_checklist_items_tenant ON release_checklist_items
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO flakey_app;
