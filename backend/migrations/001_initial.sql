CREATE TABLE IF NOT EXISTS runs (
  id            SERIAL PRIMARY KEY,
  suite_name    TEXT NOT NULL,
  branch        TEXT NOT NULL DEFAULT '',
  commit_sha    TEXT NOT NULL DEFAULT '',
  ci_run_id     TEXT NOT NULL DEFAULT '',
  reporter      TEXT NOT NULL DEFAULT 'mochawesome',
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  total         INT NOT NULL DEFAULT 0,
  passed        INT NOT NULL DEFAULT 0,
  failed        INT NOT NULL DEFAULT 0,
  skipped       INT NOT NULL DEFAULT 0,
  pending       INT NOT NULL DEFAULT 0,
  duration_ms   INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS specs (
  id            SERIAL PRIMARY KEY,
  run_id        INT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  title         TEXT NOT NULL,
  total         INT NOT NULL DEFAULT 0,
  passed        INT NOT NULL DEFAULT 0,
  failed        INT NOT NULL DEFAULT 0,
  skipped       INT NOT NULL DEFAULT 0,
  duration_ms   INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tests (
  id              SERIAL PRIMARY KEY,
  spec_id         INT NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  full_title      TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'skipped', 'pending')),
  duration_ms     INT NOT NULL DEFAULT 0,
  error_message   TEXT,
  error_stack     TEXT,
  screenshot_paths TEXT[] DEFAULT '{}',
  video_path      TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_suite ON runs(suite_name);
CREATE INDEX IF NOT EXISTS idx_runs_branch ON runs(branch);
CREATE INDEX IF NOT EXISTS idx_specs_run_id ON specs(run_id);
CREATE INDEX IF NOT EXISTS idx_tests_spec_id ON tests(spec_id);
