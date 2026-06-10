-- Audit-log tamper-evidence + SIEM export (SOC 2 / GovRAMP logging controls).
--
-- Part 1 — hash-chain columns on audit_log.
-- Each new audit row binds the previous row's entry_hash, so any later
-- edit / delete / reorder breaks the chain and is detectable (GET /audit/verify
-- walks it). Nullable, NO default ⇒ metadata-only ADD COLUMN on Postgres 11+
-- (no table rewrite, no blocking lock on a populated audit_log). Rows that
-- predate this migration keep NULL hashes and are treated as a legacy prefix by
-- the verifier — we deliberately DON'T backfill, because a full-table UPDATE
-- would take a heavy lock on a large prod audit_log. Tamper-evidence is
-- forward-looking from the first hashed row.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash  TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entry_hash TEXT;

-- Part 2 — per-org export destinations.
-- Stream the audit log to a customer SIEM over HTTP, or archive it to S3. One
-- row per destination; the flusher (src/audit-export.ts) ships new audit rows
-- (id > last_exported_id) in id order, at-least-once, advancing the cursor only
-- after a confirmed delivery — so the chain the receiver reconstructs has no
-- gaps. Disabled instance-wide unless FLAKEY_AUDIT_EXPORT_ENABLED=true; each row
-- additionally carries its own `enabled` flag.
CREATE TABLE IF NOT EXISTS audit_export_config (
  id                   BIGSERIAL PRIMARY KEY,
  org_id               INT  NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  destination          TEXT NOT NULL CHECK (destination IN ('http', 's3')),
  enabled              BOOLEAN NOT NULL DEFAULT false,
  -- http destination
  endpoint_url         TEXT,
  auth_header_name     TEXT,            -- e.g. 'Authorization', 'X-Splunk-Authorization'
  auth_token_encrypted TEXT,            -- crypto.ts envelope; never returned to clients
  -- s3 destination
  s3_bucket            TEXT,
  s3_prefix            TEXT,
  -- delivery state
  last_exported_id     BIGINT      NOT NULL DEFAULT 0,   -- cursor: highest audit_log.id confirmed delivered
  last_success_at      TIMESTAMPTZ,
  last_error           TEXT,                             -- sanitized; no raw upstream bodies
  consecutive_failures INT         NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()   -- maintained app-side (no triggers in this DB; see migration 049)
);

CREATE INDEX IF NOT EXISTS idx_audit_export_config_org ON audit_export_config(org_id);

-- Tenant isolation: same ENABLE + FORCE + policy shape as every other tenant
-- table (see 008 audit_log). FORCE so the table owner can't bypass RLS either.
ALTER TABLE audit_export_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_export_config FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_export_config_tenant ON audit_export_config;
CREATE POLICY audit_export_config_tenant ON audit_export_config
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);
