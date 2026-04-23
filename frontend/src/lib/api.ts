import { authFetch } from "./auth";
import { API_URL } from "./config.js";

export interface RunsSummary {
  total: number;
  passed: number;
  failed: number;
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
  if (!res.ok) throw new Error(`Failed to fetch run: ${res.status}`);
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
  finished_at: string;
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
}

export const UPLOADS_URL = `${API_URL}/uploads`;

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
  const qs = params.toString();
  const res = await authFetch(`${API_URL}/flaky${qs ? `?${qs}` : ""}`);
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
  const qs = suite ? `?suite=${encodeURIComponent(suite)}` : "";
  const res = await authFetch(`${API_URL}/tests/slowest/list${qs}`);
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

// --- Quarantine ---

export interface QuarantinedTest {
  id: number;
  full_title: string;
  file_path: string;
  suite_name: string;
  reason: string | null;
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
