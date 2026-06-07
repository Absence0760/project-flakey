-- Phase 14, Slice 1 — Enterprise SSO: OIDC login.
--
-- Two new org-scoped tables, both with RLS in this same migration
-- (guard rail 11). SSO is purely additive — it is a third way to MINT
-- the existing Flakey session, not a new session primitive. Nothing
-- here weakens the post-login model: same JWT, same requireAuth, same
-- org_members re-check, same RLS.
--
--   org_sso_configs  — per-org IdP configuration (one row per org).
--                      The client secret is encrypted at rest via the
--                      existing FLAKEY_ENCRYPTION_KEY path (crypto.ts),
--                      exactly like Jira / PagerDuty tokens.
--   sso_identities   — maps an IdP subject (OIDC `sub`) to a Flakey user
--                      within an org, so re-login is deterministic and
--                      account-linking is an explicit, recorded act.
--
-- SAML (Slice 2) and SCIM (Slice 3) extend org_sso_configs via their own
-- migrations rather than bundling unbuilt columns here.

-- ---------------------------------------------------------------------------
-- org_sso_configs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_sso_configs (
  id                 SERIAL PRIMARY KEY,
  org_id             INT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  protocol           TEXT NOT NULL DEFAULT 'oidc' CHECK (protocol IN ('oidc', 'saml')),

  -- Posture flags.
  enabled            BOOLEAN NOT NULL DEFAULT false,
  -- "SSO required": when true the org intends password login to be refused.
  -- Stored now; ENFORCEMENT in /auth/login is deferred pending the security
  -- review's answer to the proposal open-question (do we hard-disable
  -- password login per-org?). Do not wire enforcement off this column until
  -- that decision is signed off.
  enforced           BOOLEAN NOT NULL DEFAULT false,

  -- Provisioning policy.
  -- jit_provisioning: auto-create a member on first successful SSO login.
  -- When false, the user must already have an org_members row (invite/SCIM).
  jit_provisioning   BOOLEAN NOT NULL DEFAULT false,
  -- Email domains permitted to authenticate / JIT-provision into this org.
  -- Empty array = no domain restriction (any verified IdP email allowed).
  allowed_domains    TEXT[] NOT NULL DEFAULT '{}',
  -- Role granted to a JIT-provisioned member when the role claim is absent
  -- or unmapped. Constrained to the same set as org_members.role.
  default_role       TEXT NOT NULL DEFAULT 'viewer' CHECK (default_role IN ('owner', 'admin', 'viewer')),
  -- Name of the IdP token claim carrying the user's role(s) (e.g. flakey_roles).
  role_claim         TEXT,
  -- Map of IdP role value -> Flakey org role, e.g. {"flakey-admin":"admin"}.
  -- Values are validated in application code against the org-role set; a JSONB
  -- value that maps to an unknown role is ignored (falls back to default_role)
  -- rather than widening access.
  role_map           JSONB NOT NULL DEFAULT '{}',

  -- OIDC configuration.
  oidc_issuer        TEXT,
  oidc_client_id     TEXT,
  -- Encrypted via FLAKEY_ENCRYPTION_KEY (v1:<iv>:<tag>:<ct>); never logged.
  oidc_client_secret TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A config that is enabled for OIDC must carry the minimum to run the flow.
  -- Fail-closed: a half-configured enabled OIDC config is rejected at write
  -- time rather than producing a broken redirect at login.
  CONSTRAINT org_sso_oidc_complete CHECK (
    NOT enabled
    OR protocol <> 'oidc'
    OR (oidc_issuer IS NOT NULL AND oidc_client_id IS NOT NULL)
  )
);

-- ---------------------------------------------------------------------------
-- sso_identities
-- ---------------------------------------------------------------------------
-- One row per (org, protocol, external subject). Created on first SSO login
-- (JIT or linked to an existing invited/SCIM member) and used to resolve the
-- same Flakey user on every subsequent login — so a changed display name or
-- email at the IdP can't fork into a duplicate account.
CREATE TABLE IF NOT EXISTS sso_identities (
  id            SERIAL PRIMARY KEY,
  org_id        INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  protocol      TEXT NOT NULL CHECK (protocol IN ('oidc', 'saml')),
  -- The IdP-stable subject: OIDC `sub`. Opaque; never used as a display value.
  external_id   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  UNIQUE (org_id, protocol, external_id)
);

CREATE INDEX IF NOT EXISTS idx_sso_identities_user ON sso_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_sso_identities_org ON sso_identities(org_id);

-- ---------------------------------------------------------------------------
-- RLS — both tables are org-scoped, mirroring the existing tenant policies
-- (e.g. api_keys in 004). The app connects as non-superuser flakey_app, so
-- these FORCE policies apply to every query; reads/writes are routed through
-- tenantQuery(orgId, ...) which sets app.current_org_id for the transaction.
-- ---------------------------------------------------------------------------
ALTER TABLE org_sso_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_sso_configs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_sso_configs_tenant_isolation ON org_sso_configs;
CREATE POLICY org_sso_configs_tenant_isolation ON org_sso_configs
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

ALTER TABLE sso_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_identities FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sso_identities_tenant_isolation ON sso_identities;
CREATE POLICY sso_identities_tenant_isolation ON sso_identities
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);
