-- Schema-design audit finding H2: require the three integration-secret columns
-- to hold v1: ciphertext, so a plaintext token can never be written.
--
-- All three are written through crypto.ts encryptSecret(), whose output is
-- `v1:<base64 iv>:<base64 tag>:<base64 ct>`. A value that doesn't match that
-- shape means the secret was stored in cleartext — which happens when
-- FLAKEY_ENCRYPTION_KEY is unset (encryptSecret() is a passthrough in that
-- mode). This constraint therefore makes FLAKEY_ENCRYPTION_KEY mandatory for
-- storing integration secrets: a keyless (plaintext) write is rejected at the
-- DB boundary, so a credential can never land in a backup in the clear.
--
-- Validated immediately (no NOT VALID): there is no legacy plaintext to
-- tolerate. NULL and '' are allowed — they represent "no token configured" /
-- "token cleared".
--
-- SOC 2 / GovRAMP: encryption-at-rest for integration secrets is now enforced
-- by the schema, not just by application code.

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_git_token_fmt_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_git_token_fmt_check
  CHECK (git_token IS NULL OR git_token = '' OR git_token ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$');

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_jira_api_token_fmt_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_jira_api_token_fmt_check
  CHECK (jira_api_token IS NULL OR jira_api_token = '' OR jira_api_token ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$');

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_pagerduty_key_fmt_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_pagerduty_key_fmt_check
  CHECK (pagerduty_integration_key IS NULL OR pagerduty_integration_key = '' OR pagerduty_integration_key ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$');
