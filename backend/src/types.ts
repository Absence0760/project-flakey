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

export interface CommandEntry {
  name: string;
  message: string;
  state: string;
}

// Cypress failure-context capture (Phase 13). Browser-side runtime context for
// a failing test, gathered by the cypress-reporter support file and merged in
// by its plugin before upload. Every field is optional — only what was
// actually observed is sent. The Cypress counterpart to the Playwright
// trace -> command-log captured in NormalizedTest.metadata.retries.
export interface FailureContext {
  // Tail of cy.* commands before the failure (capped reporter-side).
  commands_tail?: CommandEntry[];
  // Browser console output, level-prefixed (e.g. "error: …", "warn: …").
  browser_console?: string[];
  // Uncaught exceptions + unhandled promise rejections at failure time.
  uncaught_errors?: string[];
  // Failed fetch/XHR requests around the failure (e.g. "GET /api/x → 500").
  network_failures?: string[];
  // Per-attempt error trail for retried tests. Non-final attempts stay
  // uncounted (reporter.ts skips them) — this just retains their errors so a
  // pass/fail delta across attempts is available to classify the flake.
  retry_errors?: { attempt: number; message: string; stack?: string }[];
  // Source-map-resolved stack frames (Phase 13). Surfaced from Cypress's own
  // resolution (err.parsedStack) so a failure points at the real spec line
  // rather than bundled webpack coordinates. Captured reporter-side.
  resolved_stack?: { file: string; line?: number; column?: number; function?: string }[];
  // The resolved failure origin + source snippet (from Cypress's err.codeFrame).
  code_frame?: { file: string; line?: number; column?: number; frame?: string };
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
  failure_context?: FailureContext;
}
