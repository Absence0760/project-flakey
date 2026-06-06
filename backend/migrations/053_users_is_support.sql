-- Platform-level support capability, distinct from the per-org membership
-- roles (owner/admin/viewer). A support user can mint a short-lived,
-- READ-ONLY "view as org" session token (see src/routes/support.ts) to triage
-- a customer ticket without joining their org as a member.
--
-- Deliberately NOT grantable via any API: it is set out-of-band by an operator
-- (e.g. UPDATE users SET is_support = true WHERE email = '…'), because a
-- self-serve grant would be a cross-tenant privilege-escalation path. Default
-- false means a stock install has no standing cross-org access.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_support BOOLEAN NOT NULL DEFAULT false;
