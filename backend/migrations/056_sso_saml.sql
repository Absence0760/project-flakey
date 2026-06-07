-- Phase 14, Slice 2 — Enterprise SSO: SAML login.
--
-- Extends org_sso_configs with the SAML SP/IdP fields and adds two org-scoped
-- helper tables (both with RLS in this migration, guard rail 11):
--
--   sso_saml_requests — pending AuthnRequest IDs. Written at /start, consumed
--                       once at the ACS to validate InResponseTo. This is our
--                       org-scoped replacement for node-saml's cross-task
--                       cache: the org is carried in a signed RelayState (not a
--                       cookie, which SameSite would strip from the IdP's POST),
--                       so the ACS knows the org and reads under RLS.
--   sso_saml_replay   — consumed assertion hashes. An assertion (signed,
--                       audience-bound, time-windowed by node-saml) may be used
--                       exactly once; a replay collides here and is refused.
--
-- The IdP signing certificate is a PUBLIC cert — stored plaintext (unlike the
-- OIDC client secret). We use no SP private key (unsigned AuthnRequest), so no
-- new secret is introduced.

ALTER TABLE org_sso_configs ADD COLUMN IF NOT EXISTS saml_entry_point TEXT; -- IdP SSO URL (HTTP-Redirect/POST)
ALTER TABLE org_sso_configs ADD COLUMN IF NOT EXISTS saml_idp_cert    TEXT; -- IdP signing cert (PEM/base64 body)
ALTER TABLE org_sso_configs ADD COLUMN IF NOT EXISTS saml_issuer      TEXT; -- SP entityID (this app)
ALTER TABLE org_sso_configs ADD COLUMN IF NOT EXISTS saml_audience    TEXT; -- expected assertion audience (defaults to saml_issuer)

-- Fail closed: an enabled SAML config must carry the IdP entry point + cert.
ALTER TABLE org_sso_configs DROP CONSTRAINT IF EXISTS org_sso_saml_complete;
ALTER TABLE org_sso_configs ADD CONSTRAINT org_sso_saml_complete CHECK (
  NOT enabled
  OR protocol <> 'saml'
  OR (saml_entry_point IS NOT NULL AND saml_idp_cert IS NOT NULL)
);

-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sso_saml_requests (
  id          SERIAL PRIMARY KEY,
  org_id      INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  state       TEXT NOT NULL,         -- opaque token echoed back via RelayState
  request_id  TEXT NOT NULL,         -- the AuthnRequest ID we issued
  expires_at  TIMESTAMPTZ NOT NULL,  -- short (minutes); pruned opportunistically
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, state)
);
CREATE INDEX IF NOT EXISTS idx_sso_saml_requests_expires ON sso_saml_requests(expires_at);

CREATE TABLE IF NOT EXISTS sso_saml_replay (
  id             SERIAL PRIMARY KEY,
  org_id         INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assertion_hash TEXT NOT NULL,      -- sha256 of the validated assertion XML
  expires_at     TIMESTAMPTZ NOT NULL, -- = assertion NotOnOrAfter; safe to prune after
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, assertion_hash)
);
CREATE INDEX IF NOT EXISTS idx_sso_saml_replay_expires ON sso_saml_replay(expires_at);

-- ---------------------------------------------------------------------------
-- RLS — both org-scoped, accessed via tenantQuery(orgId, ...).
-- ---------------------------------------------------------------------------
ALTER TABLE sso_saml_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_saml_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sso_saml_requests_tenant_isolation ON sso_saml_requests;
CREATE POLICY sso_saml_requests_tenant_isolation ON sso_saml_requests
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

ALTER TABLE sso_saml_replay ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_saml_replay FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sso_saml_replay_tenant_isolation ON sso_saml_replay;
CREATE POLICY sso_saml_replay_tenant_isolation ON sso_saml_replay
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);
