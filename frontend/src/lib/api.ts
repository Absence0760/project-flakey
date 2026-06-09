// NOTE: these request/response types are HAND-SYNCED with backend/src/types.ts +
// the DB. A typed contract is being migrated to OpenAPI: backend/openapi.yaml is
// the source of truth and generates ./api-generated.ts via `pnpm openapi:generate`
// (it covers the core routes today). New/changed routes that are in the spec must
// update openapi.yaml in the same commit (`pnpm openapi:check` flags drift);
// prefer importing the generated types here as routes are migrated.
import { authFetch, getToken } from "./stores/auth";
import { API_URL } from "./utils/config.js";
import type { components } from "./api-generated";

// Prefer the server's `{ error }` message over a bare status code so users see
// "Run not found" instead of "Failed to fetch run: 404". Falls back to the
// status when the body isn't the expected JSON shape.
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.clone().json();
    if (body && typeof body.error === "string" && body.error.trim()) return body.error;
  } catch {
    /* non-JSON body — fall through to the status */
  }
  return `${fallback}: ${res.status}`;
}

export interface RunsSummary {
  total: number;
  passed: number;
  failed: number;
  // Runs still in progress (finished_at IS NULL — includes most aborted runs,
  // which never merge) are excluded from `passed`/`failed` and counted here, so
  // a not-yet-finished run never inflates the pass count. A finished-but-aborted
  // run counts as `failed`. `passed + failed + incomplete === total`.
  incomplete: number;
}

export async function fetchRuns(): Promise<Run[]> {
  const res = await authFetch(`${API_URL}/runs`);
  if (!res.ok) throw new Error(`Failed to fetch runs: ${res.status}`);
  const data = await res.json();
  return data.runs;
}

export async function fetchRunsWithSummary(offset = 0, limit = 50): Promise<{ runs: Run[]; summary: RunsSummary; hasMore: boolean }> {
  const res = await authFetch(`${API_URL}/runs?limit=${limit}&offset=${offset}`);
  if (!res.ok) throw new Error(`Failed to fetch runs: ${res.status}`);
  return res.json();
}

export async function fetchRun(id: number): Promise<RunDetail> {
  const res = await authFetch(`${API_URL}/runs/${id}`);
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to fetch run"));
  return res.json();
}

export interface Run {
  id: number;
  suite_name: string;
  branch: string;
  commit_sha: string;
  ci_run_id: string;
  reporter: string;
  started_at: string;
  // null until the run merges/completes (migration 050) — live runs start
  // with no finish time. The runs/[id] page guards with `if (run.finished_at)`.
  finished_at: string | null;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  pending: number;
  duration_ms: number;
  created_at: string;
  spec_count: number;
  spec_files: string[] | null;
  new_failures: number;
  aborted?: boolean;
  // `runs.environment` is `NOT NULL DEFAULT ''` (migration 033) so the
  // backend always returns a string here, never null/undefined. Empty
  // string means "no environment label set".
  environment: string;
}

export async function fetchEnvironments(): Promise<string[]> {
  const res = await authFetch(`${API_URL}/runs/environments`);
  if (!res.ok) throw new Error(`Failed to fetch environments: ${res.status}`);
  const data = await res.json() as { environments: string[] };
  return data.environments ?? [];
}

export const UPLOADS_URL = `${API_URL}/uploads`;

/**
 * Build an artifact URL with the auth token baked into the query string.
 *
 * The /uploads/* route on the backend now requires authentication and
 * verifies the run id in the path belongs to the caller's org.  HTML
 * `<img>` and `<video>` elements can't attach an Authorization header,
 * so the backend also accepts `?token=<jwt-or-api-key>` (same pattern
 * the live SSE endpoint uses).
 *
 * Pass storage paths (e.g. "runs/42/screenshots/foo.png") — they're
 * already URL-encoded by the upload pipeline.  When the user is not
 * logged in, returns the URL without a token (the request will 401,
 * which the consumer can render as a broken image gracefully).
 */
export function artifactSrc(path: string | null | undefined): string {
  if (!path) return "";
  if (path.startsWith("http")) return path; // S3 presigned URL passthrough
  const token = getToken();
  const base = `${UPLOADS_URL}/${path}`;
  return token ? `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : base;
}

export interface TestResult {
  id: number;
  spec_id: number;
  title: string;
  full_title: string;
  status: "passed" | "failed" | "skipped" | "pending";
  duration_ms: number;
  error_message: string | null;
  error_stack: string | null;
  screenshot_paths: string[];
  video_path: string | null;
  test_code: string | null;
  command_log: CommandLogEntry[] | null;
  metadata: TestMetadata | null;
  snapshot_path: string | null;
  failure_context: FailureContext | null;
}

// Cypress failure-context capture (Phase 13). Browser-side runtime context for
// a failing test — the Cypress counterpart to Playwright's metadata.retries.
// Every field is optional; only what was observed is present.
export interface FailureContext {
  commands_tail?: CommandLogEntry[];
  browser_console?: string[];
  uncaught_errors?: string[];
  network_failures?: string[];
  retry_errors?: { attempt: number; message: string; stack?: string }[];
  // Source-map-resolved frames + code frame (from Cypress's own resolution),
  // so a failure points at the real spec line rather than bundled coordinates.
  resolved_stack?: { file: string; line?: number; column?: number; function?: string }[];
  code_frame?: { file: string; line?: number; column?: number; frame?: string };
}

export interface TestMetadata {
  // Playwright-specific
  retries?: { attempt: number; status: string; duration: number; error?: { message: string; stack?: string } }[];
  annotations?: { type: string; description?: string }[];
  tags?: string[];
  location?: { file: string; line: number; column: number };
  error_snippet?: string;
  // JUnit-specific
  classname?: string;
  error_type?: string;
  properties?: Record<string, string>;
  hostname?: string;
  skip_message?: string;
  // Shared
  stdout?: string[];
  stderr?: string[];
}

export interface CommandLogEntry {
  name: string;
  message: string;
  state: string;
}

export interface TestDetail extends TestResult {
  file_path: string;
  run_id: number;
  spec_title: string;
  prev_failed_id: number | null;
  next_failed_id: number | null;
  failed_index: number;
  failed_total: number;
}

export async function fetchTest(id: number): Promise<TestDetail> {
  const res = await authFetch(`${API_URL}/tests/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch test: ${res.status}`);
  return res.json();
}

export interface TestHistoryEntry {
  test_id: number;
  status: string;
  duration_ms: number;
  error_message: string | null;
  run_id: number;
  suite_name: string;
  branch: string;
  created_at: string;
}

export interface TestHistory {
  title: string;
  full_title: string;
  file_path: string;
  history: TestHistoryEntry[];
}

export async function fetchTestHistory(id: number): Promise<TestHistory> {
  const res = await authFetch(`${API_URL}/tests/${id}/history`);
  if (!res.ok) throw new Error(`Failed to fetch test history: ${res.status}`);
  return res.json();
}

export interface Spec {
  id: number;
  run_id: number;
  file_path: string;
  title: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  pending: number;
  duration_ms: number;
  tests: TestResult[];
}

export interface RunDetail extends Run {
  specs: Spec[];
  rerun_command_template: string | null;
  prev_id: number | null;
  next_id: number | null;
  aborted_reason?: string | null;
}

export interface ErrorGroup {
  fingerprint: string;
  error_message: string;
  occurrence_count: number;
  affected_tests: number;
  affected_runs: number;
  first_seen: string;
  last_seen: string;
  latest_run_id: number;
  latest_test_id: number | null;
  test_titles: string[];
  file_paths: string[];
  suite_name: string;
  group_id: number | null;
  status: string;
  note_count: number;
}

export interface AffectedTest {
  full_title: string;
  title: string;
  file_path: string;
  suite_name: string;
  occurrence_count: number;
  last_seen: string;
  latest_test_id: number;
  latest_run_id: number;
}

export interface ErrorNote {
  id: number;
  body: string;
  created_at: string;
  user_name: string | null;
  user_email: string;
}

export interface Note {
  id: number;
  body: string;
  target_type: string;
  target_key: string;
  created_at: string;
  user_name: string | null;
  user_email: string;
}

export async function fetchNotes(targetType: string, targetKey: string): Promise<Note[]> {
  const params = new URLSearchParams({ target_type: targetType, target_key: targetKey });
  const res = await authFetch(`${API_URL}/notes?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch notes: ${res.status}`);
  return res.json();
}

export async function fetchNoteCounts(targetType: string, targetKeys: string[]): Promise<Record<string, number>> {
  const params = new URLSearchParams({ target_type: targetType, target_keys: targetKeys.join(",") });
  const res = await authFetch(`${API_URL}/notes/counts?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch note counts: ${res.status}`);
  return res.json();
}

export async function addNote(targetType: string, targetKey: string, body: string): Promise<Note> {
  const res = await authFetch(`${API_URL}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target_type: targetType, target_key: targetKey, body }),
  });
  if (!res.ok) throw new Error(`Failed to add note: ${res.status}`);
  return res.json();
}

export async function fetchErrors(filters?: { suite?: string; status?: string }): Promise<ErrorGroup[]> {
  const params = new URLSearchParams();
  if (filters?.suite) params.set("suite", filters.suite);
  if (filters?.status) params.set("status", filters.status);
  const qs = params.toString();
  const res = await authFetch(`${API_URL}/errors${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Failed to fetch errors: ${res.status}`);
  return res.json();
}

export async function fetchAffectedTests(fingerprint: string): Promise<AffectedTest[]> {
  const res = await authFetch(`${API_URL}/errors/${fingerprint}/tests`);
  if (!res.ok) throw new Error(`Failed to fetch affected tests: ${res.status}`);
  return res.json();
}

export async function updateErrorStatus(fingerprint: string, status: string): Promise<void> {
  const res = await authFetch(`${API_URL}/errors/${fingerprint}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`Failed to update status: ${res.status}`);
}

export async function fetchErrorNotes(fingerprint: string): Promise<ErrorNote[]> {
  const res = await authFetch(`${API_URL}/errors/${fingerprint}/notes`);
  if (!res.ok) throw new Error(`Failed to fetch notes: ${res.status}`);
  return res.json();
}

export async function addErrorNote(fingerprint: string, body: string): Promise<ErrorNote> {
  const res = await authFetch(`${API_URL}/errors/${fingerprint}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`Failed to add note: ${res.status}`);
  return res.json();
}

export interface FlakyTest {
  full_title: string;
  title: string;
  file_path: string;
  suite_name: string;
  total_runs: number;
  pass_count: number;
  fail_count: number;
  flip_count: number;
  flaky_rate: number;
  first_seen: string;
  last_seen: string;
  timeline: string[];
  run_ids: number[];
  latest_run_id: number;
}

export async function fetchFlakyTests(filters?: { suite?: string; runs?: number }): Promise<FlakyTest[]> {
  const params = new URLSearchParams();
  if (filters?.suite) params.set("suite", filters.suite);
  if (filters?.runs) params.set("runs", String(filters.runs));
  // Ask for the backend's maximum so the client has room to paginate.
  // Backend caps at 200 (src/routes/flaky.ts).
  params.set("limit", "200");
  const qs = params.toString();
  const res = await authFetch(`${API_URL}/flaky?${qs}`);
  if (!res.ok) throw new Error(`Failed to fetch flaky tests: ${res.status}`);
  return res.json();
}

export async function fetchStats(filters?: { from?: string; to?: string }): Promise<DashboardStats> {
  const params = new URLSearchParams();
  if (filters?.from) params.set("from", filters.from);
  if (filters?.to) params.set("to", filters.to);
  const qs = params.toString();
  const res = await authFetch(`${API_URL}/stats${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`);
  return res.json();
}

export interface TrendPoint {
  date: string;
  runs: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  pass_rate: number;
}

export interface FailureTrendPoint {
  date: string;
  failures: number;
}

export interface DurationTrendPoint {
  date: string;
  avg_duration_ms: number;
  max_duration_ms: number;
}

export interface TopFailure {
  test_title: string;
  file_path: string;
  failure_count: number;
  last_failed: string;
}

export interface TrendsData {
  pass_rate: TrendPoint[];
  failures: FailureTrendPoint[];
  duration: DurationTrendPoint[];
  top_failures: TopFailure[];
}

export async function fetchTrends(filters?: { from?: string; to?: string }): Promise<TrendsData> {
  const params = new URLSearchParams();
  if (filters?.from) params.set("from", filters.from);
  if (filters?.to) params.set("to", filters.to);
  const qs = params.toString();
  const res = await authFetch(`${API_URL}/stats/trends${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Failed to fetch trends: ${res.status}`);
  return res.json();
}

export interface CompareResult {
  run_a: Run;
  run_b: Run;
  summary: Record<string, number>;
  comparisons: CompareEntry[];
}

export interface CompareEntry {
  key: string;
  file_path: string;
  title: string;
  category: string;
  a: { id: number; status: string; duration_ms: number; error_message: string | null } | null;
  b: { id: number; status: string; duration_ms: number; error_message: string | null } | null;
  duration_delta: number | null;
}

export async function fetchCompare(runIdA: number, runIdB: number): Promise<CompareResult> {
  const res = await authFetch(`${API_URL}/compare?a=${runIdA}&b=${runIdB}`);
  if (!res.ok) throw new Error(`Failed to compare runs: ${res.status}`);
  return res.json();
}

export interface SuiteComparison {
  suite_name: string;
  latest: { id: number; total: number; passed: number; failed: number; skipped: number; duration_ms: number; branch: string; created_at: string };
  previous: { id: number; total: number; passed: number; failed: number; skipped: number; duration_ms: number; branch: string; created_at: string } | null;
  diff: { total: number; passed: number; failed: number; skipped: number; duration_ms: number; pass_rate: number } | null;
}

export async function fetchSuiteComparisons(filters?: { from?: string; to?: string }): Promise<SuiteComparison[]> {
  const params = new URLSearchParams();
  if (filters?.from) params.set("from", filters.from);
  if (filters?.to) params.set("to", filters.to);
  const qs = params.toString();
  const res = await authFetch(`${API_URL}/compare/suites${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Failed to fetch suite comparisons: ${res.status}`);
  return res.json();
}

export interface SlowestTest {
  title: string;
  file_path: string;
  suite_name: string;
  avg_duration_ms: number;
  max_duration_ms: number;
  min_duration_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  run_count: number;
  last_seen: string;
  first_seen: string;
  duration_history: number[];
  trend_pct: number;
}

export async function fetchSlowestTests(suite?: string): Promise<SlowestTest[]> {
  const params = new URLSearchParams();
  if (suite) params.set("suite", suite);
  // Ask for the backend's maximum so the client has room to paginate.
  // Backend caps at 100 (src/routes/tests.ts).
  params.set("limit", "100");
  const res = await authFetch(`${API_URL}/tests/slowest/list?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch slowest tests: ${res.status}`);
  return res.json();
}

export interface DashboardStats {
  automated: {
    total_runs: number;
    total_tests: number;
    total_passed: number;
    total_failed: number;
    pass_rate: number;
    recent_runs: Run[];
    recent_failures: { test_title: string; error_message: string; run_id: number; file_path: string }[];
  };
  manual: {
    total: number;
    passed: number;
    failed: number;
    blocked: number;
    skipped: number;
    not_run: number;
    executed: number;
    total_runs: number;
    passed_runs: number;
    failed_runs: number;
    pass_rate: number;
    recent_results: { id: number; title: string; suite_name: string | null; status: string; last_run_at: string | null; last_run_by_email: string | null }[];
    recent_failures: { id: number; title: string; suite_name: string | null; last_run_at: string | null; last_run_notes: string | null }[];
  };
}

// --- Saved Views ---

export interface SavedView {
  id: number;
  name: string;
  page: string;
  filters: Record<string, string>;
  created_at: string;
}

export async function fetchSavedViews(page?: string): Promise<SavedView[]> {
  const params = page ? `?page=${page}` : "";
  const res = await authFetch(`${API_URL}/views${params}`);
  if (!res.ok) return [];
  return res.json();
}

export async function createSavedView(name: string, page: string, filters: Record<string, string>): Promise<SavedView> {
  const res = await authFetch(`${API_URL}/views`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, page, filters }),
  });
  if (!res.ok) throw new Error("Failed to save view");
  return res.json();
}

export async function deleteSavedView(id: number): Promise<void> {
  await authFetch(`${API_URL}/views/${id}`, { method: "DELETE" });
}

// --- AI Analysis ---

export interface AIAnalysis {
  target_type: string;
  target_key: string;
  classification: string;
  summary: string;
  suggested_fix: string;
  confidence: number;
}

export interface FlakyAnalysis {
  rootCause: string;
  stabilizationSuggestion: string;
  shouldQuarantine: boolean;
  severity: string;
}

export interface SimilarError {
  fingerprint: string;
  error_message: string;
  suite_name: string;
  occurrence_count: number;
  status: string;
  similarity: number;
}

export async function checkAIEnabled(): Promise<boolean> {
  const res = await authFetch(`${API_URL}/analyze/status`);
  if (!res.ok) return false;
  const data = await res.json() as { enabled: boolean };
  return data.enabled;
}

export async function analyzeError(fingerprint: string): Promise<AIAnalysis> {
  const res = await authFetch(`${API_URL}/analyze/error/${fingerprint}`, { method: "POST" });
  if (!res.ok) throw new Error("Analysis failed");
  return res.json();
}

// Analyze a single failed test by id. Resolves to the same error fingerprint
// (and cache) as analyzeError(), so the test-detail modal and the aggregated
// /errors view share one analysis. Pass refresh=true to force a fresh model
// call that replaces the cached row (used by "Re-analyze").
export async function analyzeTest(testId: number, refresh = false): Promise<AIAnalysis> {
  const qs = refresh ? "?refresh=true" : "";
  const res = await authFetch(`${API_URL}/analyze/test/${testId}${qs}`, { method: "POST" });
  if (!res.ok) throw new Error("Analysis failed");
  return res.json();
}

export async function analyzeFlakyTest(params: {
  fullTitle: string;
  filePath: string;
  suiteName: string;
  flakyRate: number;
  flipCount: number;
  totalRuns: number;
  timeline: string[];
}): Promise<FlakyAnalysis> {
  const res = await authFetch(`${API_URL}/analyze/flaky`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error("Analysis failed");
  return res.json();
}

export async function findSimilarErrors(fingerprint: string): Promise<SimilarError[]> {
  const res = await authFetch(`${API_URL}/analyze/similar/${fingerprint}`, { method: "POST" });
  if (!res.ok) return [];
  return res.json();
}

// --- Root-cause clustering (B2) ---
// Deterministic grouping of an org's distinct failed errors by token similarity.
// Clusters are always returned even with AI off; `theme`/`summary` are the only
// AI-dependent fields and stay null until labeled (AI off, viewer, or singleton).

export interface ErrorClusterMember {
  fingerprint: string;
  error_message: string;
  suite_name: string;
  occurrence_count: number;
  status: string;
}

export interface ErrorCluster {
  target_key: string;
  theme: string | null;
  summary: string | null;
  member_count: number;
  total_occurrences: number;
  representative_fingerprint: string;
  members: ErrorClusterMember[];
}

export async function fetchErrorClusters(): Promise<ErrorCluster[]> {
  const res = await authFetch(`${API_URL}/analyze/clusters`, { method: "POST" });
  if (!res.ok) throw new Error("Analysis failed");
  const data = await res.json() as { clusters: ErrorCluster[] };
  return data.clusters;
}

// --- AI-generated fix PR (B3) ---
// Pass exactly one of testId / fingerprint. The PR is always a reviewable draft,
// never auto-merged. Type comes from openapi.yaml (the route is in the spec).
export type FixPrResult = components["schemas"]["FixPrResult"];

export async function createFixPr(
  params: { testId?: number; fingerprint?: string },
): Promise<FixPrResult> {
  const res = await authFetch(`${API_URL}/analyze/fix-pr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    // Surface the backend's specific message ("No git provider configured",
    // "File too large for automated fix", etc.) so the UI can show it.
    let message = "Failed to open fix PR";
    try {
      const data = await res.json() as { error?: string };
      if (data?.error) message = data.error;
    } catch { /* non-JSON body — keep the generic message */ }
    throw new Error(message);
  }
  return res.json();
}

// --- Webhook event catalog ---
// The canonical list of dispatchable webhook events + friendly labels, served
// by the backend so the settings picker can't drift from what the dispatcher
// actually emits. These `event` values round-trip directly to POST/PATCH
// /webhooks.
export interface WebhookEventOption {
  event: string;
  label: string;
}

export async function fetchWebhookEvents(): Promise<WebhookEventOption[]> {
  const res = await authFetch(`${API_URL}/webhooks/events`);
  if (!res.ok) throw new Error("Failed to load webhook events");
  const data = await res.json() as { events: WebhookEventOption[] };
  return data.events;
}

// --- Quarantine ---

export interface QuarantinedTest {
  id: number;
  full_title: string;
  file_path: string;
  suite_name: string;
  reason: string | null;
  source: string;
  quarantined_by_name: string;
  created_at: string;
}

export async function fetchQuarantinedTests(suite?: string): Promise<QuarantinedTest[]> {
  const params = suite ? `?suite=${encodeURIComponent(suite)}` : "";
  const res = await authFetch(`${API_URL}/quarantine${params}`);
  if (!res.ok) return [];
  return res.json();
}

export async function quarantineTest(fullTitle: string, filePath: string, suiteName: string, reason?: string): Promise<void> {
  await authFetch(`${API_URL}/quarantine`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fullTitle, filePath, suiteName, reason }),
  });
}

export async function unquarantineTest(fullTitle: string, suiteName: string): Promise<void> {
  await authFetch(`${API_URL}/quarantine`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fullTitle, suiteName }),
  });
}

// --- Org flaky-automation settings ---
//
// Read/written via the shared GET/PATCH /orgs/:id/settings route (same
// endpoint that backs git-provider + retention). All four fields come from
// migration 060. `flaky_alert_threshold` is a Postgres `numeric`, which
// serializes to JSON as a string (e.g. "25") or null — coerce on read.
export interface FlakyAutomationSettings {
  auto_quarantine_enabled: boolean;
  auto_quarantine_min_flips: number;
  auto_quarantine_min_runs: number;
  // null = alerting disabled.
  flaky_alert_threshold: number | null;
}

export async function fetchFlakyAutomationSettings(orgId: number): Promise<FlakyAutomationSettings> {
  const res = await authFetch(`${API_URL}/orgs/${orgId}/settings`);
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to load flaky-automation settings"));
  const data = await res.json();
  const threshold = data.flaky_alert_threshold;
  return {
    auto_quarantine_enabled: !!data.auto_quarantine_enabled,
    auto_quarantine_min_flips: Number(data.auto_quarantine_min_flips),
    auto_quarantine_min_runs: Number(data.auto_quarantine_min_runs),
    flaky_alert_threshold: threshold == null ? null : Number(threshold),
  };
}

// Partial PATCH — send only the fields that changed. `flaky_alert_threshold:
// null` disables alerting. The backend validates/clamps each field.
export async function updateFlakyAutomationSettings(
  orgId: number,
  patch: Partial<FlakyAutomationSettings>,
): Promise<void> {
  const res = await authFetch(`${API_URL}/orgs/${orgId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to save flaky-automation settings"));
}

// --- Audit log ---

export interface AuditEntry {
  id: number;
  action: string;
  target_type: string;
  target_id: string;
  detail: Record<string, unknown> | null;
  created_at: string;
  user_email: string;
  user_name: string;
}

export interface AuditLogFilters {
  limit?: number;
  offset?: number;
  action?: string;
  startDate?: string;
  endDate?: string;
}

// GET /audit — server-side filtered, offset-paginated. Returns a JSON array of
// rows. Callers page with `offset` and keep offering "load more" while the last
// page returned a full page (length === limit). Backend caps `limit` at 1000.
export async function fetchAuditLog(filters?: AuditLogFilters): Promise<AuditEntry[]> {
  const params = new URLSearchParams();
  if (filters?.limit != null) params.set("limit", String(filters.limit));
  if (filters?.offset != null) params.set("offset", String(filters.offset));
  if (filters?.action) params.set("action", filters.action);
  if (filters?.startDate) params.set("start_date", filters.startDate);
  if (filters?.endDate) params.set("end_date", filters.endDate);
  const qs = params.toString();
  const res = await authFetch(`${API_URL}/audit${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Failed to fetch audit log: ${res.status}`);
  return res.json();
}
