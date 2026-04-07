-- Update role constraint to use viewer instead of member
ALTER TABLE org_members DROP CONSTRAINT IF EXISTS org_members_role_check;
ALTER TABLE org_members ADD CONSTRAINT org_members_role_check CHECK (role IN ('owner', 'admin', 'viewer'));
UPDATE org_members SET role = 'viewer' WHERE role = 'member';

ALTER TABLE org_invites DROP CONSTRAINT IF EXISTS org_invites_role_check;
ALTER TABLE org_invites ADD CONSTRAINT org_invites_role_check CHECK (role IN ('admin', 'viewer'));
UPDATE org_invites SET role = 'viewer' WHERE role = 'member';

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
