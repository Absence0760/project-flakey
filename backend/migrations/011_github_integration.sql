ALTER TABLE organizations ADD COLUMN IF NOT EXISTS github_token TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS github_repo TEXT;
