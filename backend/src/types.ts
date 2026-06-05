export interface NormalizedRun {
  meta: {
    suite_name: string;
    branch: string;
    commit_sha: string;
    ci_run_id: string;
    started_at: string;
    finished_at: string;
    reporter: string;
    // Optional version label set by the reporter via `release` option
    // or FLAKEY_RELEASE env. When present the backend upserts a
    // releases row and links the run to it (release_runs join).
    // Absent/empty → run is unlinked.
    release?: string;
    // Target environment label (qa/stage/prod). Reporter resolves from
    // config → FLAKEY_ENV → TEST_ENV. Stored as `runs.environment`
    // (NOT NULL DEFAULT '' per migration 033) so the DB never holds
    // null even when the reporter sends an empty string.
    environment?: string;
  };
  stats: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    pending: number;
    duration_ms: number;
  };
  specs: NormalizedSpec[];
}

export interface NormalizedSpec {
  file_path: string;
  title: string;
  stats: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    pending: number;
    duration_ms: number;
  };
  tests: NormalizedTest[];
}

export interface NormalizedTest {
  title: string;
  full_title: string;
  status: "passed" | "failed" | "skipped" | "pending";
  duration_ms: number;
  error?: {
    message: string;
    stack?: string;
  };
  screenshot_paths: string[];
  video_path?: string;
  test_code?: string;
  command_log?: object[];
  metadata?: Record<string, unknown>;
}
