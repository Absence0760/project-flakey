CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

-- No default admin is seeded here. Shipping a known-credential admin on
-- every fresh DB meant a fresh production install came up with a
-- publicly-known login. The first admin now comes from the env-gated
-- bootstrap (FLAKEY_BOOTSTRAP_ADMIN_EMAIL / FLAKEY_BOOTSTRAP_ADMIN_PASSWORD,
-- applied at boot by src/bootstrap-admin.ts), or from `npm run seed` in dev
-- (admin@example.com / admin). No default credentials are ever shipped.
