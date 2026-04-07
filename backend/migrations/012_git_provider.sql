-- Generic git provider columns (replaces github-specific ones)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS git_provider TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS git_token TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS git_repo TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS git_base_url TEXT;

-- Migrate existing GitHub data
UPDATE organizations
SET git_provider = 'github', git_token = github_token, git_repo = github_repo
WHERE github_token IS NOT NULL AND github_repo IS NOT NULL
  AND git_provider IS NULL;

-- Drop old columns
ALTER TABLE organizations DROP COLUMN IF EXISTS github_token;
ALTER TABLE organizations DROP COLUMN IF EXISTS github_repo;
