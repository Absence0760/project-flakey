-- 1. Organizations
CREATE TABLE IF NOT EXISTS organizations (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Org membership
CREATE TABLE IF NOT EXISTS org_members (
  id        SERIAL PRIMARY KEY,
  org_id    INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org ON org_members(org_id);

-- 3. Invites
CREATE TABLE IF NOT EXISTS org_invites (
  id          SERIAL PRIMARY KEY,
  org_id      INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  token       TEXT UNIQUE NOT NULL,
  invited_by  INT NOT NULL REFERENCES users(id),
  accepted_at TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_invites_token ON org_invites(token);
CREATE INDEX IF NOT EXISTS idx_org_invites_email ON org_invites(email);

-- 4. Add org_id columns
ALTER TABLE runs ADD COLUMN IF NOT EXISTS org_id INT REFERENCES organizations(id);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS org_id INT REFERENCES organizations(id);

-- 5. Create default org and assign existing data
INSERT INTO organizations (name, slug) VALUES ('Default', 'default')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO org_members (org_id, user_id, role)
SELECT o.id, u.id, 'owner'
FROM organizations o, users u
WHERE o.slug = 'default'
ON CONFLICT (org_id, user_id) DO NOTHING;

UPDATE runs SET org_id = (SELECT id FROM organizations WHERE slug = 'default') WHERE org_id IS NULL;
UPDATE api_keys SET org_id = (SELECT id FROM organizations WHERE slug = 'default') WHERE org_id IS NULL;

-- 6. Enforce NOT NULL now that data is migrated
ALTER TABLE runs ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE api_keys ALTER COLUMN org_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runs_org ON runs(org_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys(org_id);

-- 7. Security definer function for API key lookup (bypasses RLS)
CREATE OR REPLACE FUNCTION lookup_api_key(p_prefix TEXT)
RETURNS TABLE(key_id INT, key_hash TEXT, user_id INT, email TEXT, name TEXT, user_role TEXT, org_id INT)
LANGUAGE sql SECURITY DEFINER
AS $$
  SELECT ak.id, ak.key_hash, u.id, u.email, u.name, u.role, ak.org_id
  FROM api_keys ak JOIN users u ON u.id = ak.user_id
  WHERE ak.key_prefix = p_prefix;
$$;

-- 8. Enable RLS
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs FORCE ROW LEVEL SECURITY;

ALTER TABLE specs ENABLE ROW LEVEL SECURITY;
ALTER TABLE specs FORCE ROW LEVEL SECURITY;

ALTER TABLE tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE tests FORCE ROW LEVEL SECURITY;

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

-- 9. RLS policies
CREATE POLICY runs_tenant_isolation ON runs
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

CREATE POLICY api_keys_tenant_isolation ON api_keys
  USING (org_id = current_setting('app.current_org_id', true)::int)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::int);

CREATE POLICY specs_tenant_isolation ON specs
  USING (run_id IN (SELECT id FROM runs));

CREATE POLICY tests_tenant_isolation ON tests
  USING (spec_id IN (SELECT id FROM specs));
