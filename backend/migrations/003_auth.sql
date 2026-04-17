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

-- Seed a default admin user (password: "admin")
-- bcrypt hash of "admin"
INSERT INTO users (email, password_hash, name, role)
VALUES ('admin@example.com', '$2b$10$Jn1RIGWrnSs77uzGaNRa1epUncrMzFwBjy00KbD3GWY14lZTR8jAO', 'Admin', 'admin')
ON CONFLICT (email) DO NOTHING;
