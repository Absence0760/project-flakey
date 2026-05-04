-- Native security-findings ingestion (issue tracked via examples/zap/README).
--
-- Mirrors the shape of a11y_reports / visual_diffs / coverage_reports:
-- one row per finding, scoped to a run, RLS by org_id.  The full raw
-- scanner payload is stored alongside the normalized rows so the original
-- ZAP/Trivy/etc. JSON remains queryable without re-running the scan.

CREATE TABLE IF NOT EXISTS security_scans (
  id          SERIAL PRIMARY KEY,
  org_id      INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id      INT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  -- Scanner identity ("zap", "trivy", "bandit", …).  Free-form so adding a
  -- new scanner doesn't require a migration.
  scanner     TEXT NOT NULL,
  target      TEXT,
  -- Aggregate counters for cheap dashboard rendering without re-aggregating
  -- the findings table.
  high_count  INT NOT NULL DEFAULT 0,
  medium_count INT NOT NULL DEFAULT 0,
  low_count   INT NOT NULL DEFAULT 0,
  info_count  INT NOT NULL DEFAULT 0,
  -- Raw scanner output (e.g. zap-report.json) for forensics / re-render.
  raw_report  JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(run_id, scanner)
);
CREATE INDEX IF NOT EXISTS idx_security_scans_org ON security_scans(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_scans_run ON security_scans(run_id);

ALTER TABLE security_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_scans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_scans_tenant ON security_scans;
CREATE POLICY security_scans_tenant ON security_scans
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

CREATE TABLE IF NOT EXISTS security_findings (
  id          SERIAL PRIMARY KEY,
  scan_id     INT NOT NULL REFERENCES security_scans(id) ON DELETE CASCADE,
  org_id      INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id      INT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  -- Stable identifier for dedup / accept-as-known-issue across runs.
  rule_id     TEXT,
  name        TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('high','medium','low','info')),
  description TEXT,
  solution    TEXT,
  url         TEXT,
  cwe         TEXT,
  instances   INT NOT NULL DEFAULT 1,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_security_findings_scan ON security_findings(scan_id);
CREATE INDEX IF NOT EXISTS idx_security_findings_run_severity ON security_findings(run_id, severity);

ALTER TABLE security_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_findings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_findings_tenant ON security_findings;
CREATE POLICY security_findings_tenant ON security_findings
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);
