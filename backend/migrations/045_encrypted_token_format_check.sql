-- Schema-design audit finding H2: enforce the ciphertext format on the three
-- integration-secret columns so a plaintext token can never be *newly* written.
--
-- All three are written through crypto.ts encryptSecret(), whose output is
-- `v1:<base64 iv>:<base64 tag>:<base64 ct>` (PREFIX = "v1:"). A row that does
-- not match that shape means the secret was stored in cleartext — which happens
-- whenever FLAKEY_ENCRYPTION_KEY is unset (encryptSecret() is a no-op passthrough
-- in that mode).
--
-- IMPORTANT — why NOT VALID:
--   Migration 012 copied the legacy `github_token` into `git_token` verbatim
--   (no encryption), and no migration ever re-encrypted it. Any DB upgraded
--   through that lineage, or any instance that ran with FLAKEY_ENCRYPTION_KEY
--   unset, holds legacy PLAINTEXT in these columns. A normal (validated) CHECK
--   would fail to apply on those DBs and block the deploy.
--   NOT VALID adds the constraint so it IS enforced on every INSERT/UPDATE going
--   forward (plaintext writes are rejected -> encryption is effectively
--   mandatory) while leaving pre-existing rows unchecked.
--
-- OPERATOR FOLLOW-UP (SOC 2 / GovRAMP — coordinate with Security/CISO):
--   Pre-existing plaintext secrets are NOT remediated by this migration and
--   cannot be (the encryption key lives in app env, not the DB). After
--   confirming no legacy plaintext remains (re-save each integration secret, or
--   add a one-time encrypt-plaintext pass — note `npm run rotate-keys` only
--   re-encrypts already-`v1:`-prefixed values and SKIPS plaintext), promote each
--   constraint with:
--     ALTER TABLE organizations VALIDATE CONSTRAINT organizations_git_token_fmt_check;
--     ALTER TABLE organizations VALIDATE CONSTRAINT organizations_jira_api_token_fmt_check;
--     ALTER TABLE organizations VALIDATE CONSTRAINT organizations_pagerduty_key_fmt_check;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_git_token_fmt_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_git_token_fmt_check
  CHECK (git_token IS NULL OR git_token = '' OR git_token ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$')
  NOT VALID;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_jira_api_token_fmt_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_jira_api_token_fmt_check
  CHECK (jira_api_token IS NULL OR jira_api_token = '' OR jira_api_token ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$')
  NOT VALID;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_pagerduty_key_fmt_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_pagerduty_key_fmt_check
  CHECK (pagerduty_integration_key IS NULL OR pagerduty_integration_key = '' OR pagerduty_integration_key ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$')
  NOT VALID;
