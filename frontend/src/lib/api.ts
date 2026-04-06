import { authFetch } from "./auth";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export async function fetchRuns(): Promise<Run[]> {
  const res = await authFetch(`${API_URL}/runs`);
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
}

export interface ErrorGroup {
  error_message: string;
  count: number;
  latest_run_id: number;
  latest_run_date: string;
  latest_test_id: number | null;
  test_title: string;
  file_path: string;
  suite_name: string;
  run_ids: number[];
}

export async function fetchErrors(filters?: { suite?: string; run_id?: number }): Promise<ErrorGroup[]> {
  const params = new URLSearchParams();
  if (filters?.suite) params.set("suite", filters.suite);
  if (filters?.run_id) params.set("run_id", String(filters.run_id));
  const qs = params.toString();
  const res = await authFetch(`${API_URL}/errors${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Failed to fetch errors: ${res.status}`);
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

export interface DashboardStats {
  total_runs: number;
  total_tests: number;
  total_passed: number;
  total_failed: number;
  pass_rate: number;
  recent_runs: Run[];
  recent_failures: { test_title: string; error_message: string; run_id: number; file_path: string }[];
}
