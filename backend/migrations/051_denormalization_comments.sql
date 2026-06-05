-- Schema-design audit findings M9, L6: document two intentional design choices
-- so future readers don't mistake them for accidents. COMMENT ON is idempotent.

-- M9: security_findings.org_id / run_id are denormalized copies of the parent
-- security_scans row, kept for RLS and query convenience. The schema can't
-- guarantee they stay consistent with the parent, so the intent is documented.
COMMENT ON COLUMN security_findings.org_id IS
  'Denormalized copy of security_scans.org_id (reachable via scan_id). Stored here so the row-level security policy can scope on org_id directly without a join. Must stay consistent with the parent scan.';
COMMENT ON COLUMN security_findings.run_id IS
  'Denormalized copy of security_scans.run_id (reachable via scan_id). Stored here for query convenience (idx_security_findings_run_severity) so per-run lookups avoid a join to security_scans. Must stay consistent with the parent scan.';

-- L6: ui_coverage has no updated_at; last_seen is bumped on every upsert and
-- doubles as the row last-modified timestamp.
COMMENT ON COLUMN ui_coverage.last_seen IS
  'Timestamp of the most recent coverage report for this (org_id, suite_name, route_pattern). Bumped to NOW() on every ON CONFLICT DO UPDATE upsert alongside visit_count, so it doubles as the row last-modified timestamp; the table has no separate updated_at column.';
