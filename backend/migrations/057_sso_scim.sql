-- Phase 14, Slice 3 — Enterprise SSO: SCIM 2.0 provisioning.
--
-- Lets an IdP (Authentik, Entra, Okta) create / update / DEACTIVATE users and
-- push group->role changes against this org via a per-org bearer token.
-- Deactivation rides the EXISTING instant-revocation guarantee: removing the
-- org_members row makes requireAuth's per-request re-read 401 the user on their
-- next call (proposal trust boundary #5) — no new revocation primitive.
--
-- New org-scoped tables (RLS in this migration, guard rail 11):
--   scim_users   — SCIM resource id <-> Flakey user_id, + active flag + raw.
--   scim_groups  — SCIM group resource (display name -> role via role_map).
-- Token: a bcrypt hash + prefix on org_sso_configs (mirrors api_keys), with a
-- SECURITY DEFINER prefix lookup so auth can resolve the org before RLS scope
-- is set (mirrors lookup_api_key in migration 004).

ALTER TABLE org_sso_configs ADD COLUMN IF NOT EXISTS scim_enabled      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE org_sso_configs ADD COLUMN IF NOT EXISTS scim_token_prefix TEXT;
ALTER TABLE org_sso_configs ADD COLUMN IF NOT EXISTS scim_token_hash   TEXT; -- bcrypt; never reversible, never logged

-- SCIM-provisioned identities reuse sso_identities; widen the protocol check.
ALTER TABLE sso_identities DROP CONSTRAINT IF EXISTS sso_identities_protocol_check;
ALTER TABLE sso_identities ADD CONSTRAINT sso_identities_protocol_check CHECK (protocol IN ('oidc', 'saml', 'scim'));

-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scim_users (
  scim_id     UUID PRIMARY KEY,
  org_id      INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_name   TEXT NOT NULL,            -- SCIM userName (usually the email)
  external_id TEXT,                      -- IdP-side externalId, if sent
  active      BOOLEAN NOT NULL DEFAULT true,
  raw         JSONB NOT NULL DEFAULT '{}', -- last representation, for GET round-trips
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, user_name)
);
CREATE INDEX IF NOT EXISTS idx_scim_users_org ON scim_users(org_id);

CREATE TABLE IF NOT EXISTS scim_groups (
  scim_id      UUID PRIMARY KEY,
  org_id       INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  raw          JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, display_name)
);
CREATE INDEX IF NOT EXISTS idx_scim_groups_org ON scim_groups(org_id);

-- ---------------------------------------------------------------------------
-- RLS — both org-scoped, accessed via tenantQuery(orgId, ...).
-- ---------------------------------------------------------------------------
ALTER TABLE scim_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE scim_users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scim_users_tenant_isolation ON scim_users;
CREATE POLICY scim_users_tenant_isolation ON scim_users
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

ALTER TABLE scim_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE scim_groups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scim_groups_tenant_isolation ON scim_groups;
CREATE POLICY scim_groups_tenant_isolation ON scim_groups
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER prefix lookup. SCIM auth runs BEFORE app.current_org_id is
-- set (we don't yet know the org). Returns only (org_id, hash) for a prefix;
-- the full token is bcrypt-compared in JS. Narrow bypass: reveals which
-- prefixes exist among SCIM-enabled orgs, not which tokens are valid.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lookup_scim_token(p_prefix TEXT)
RETURNS TABLE(org_id INT, token_hash TEXT)
LANGUAGE sql SECURITY DEFINER
AS $$
  SELECT c.org_id, c.scim_token_hash
  FROM org_sso_configs c
  WHERE c.scim_enabled = true
    AND c.scim_token_prefix = p_prefix
    AND c.scim_token_hash IS NOT NULL;
$$;
