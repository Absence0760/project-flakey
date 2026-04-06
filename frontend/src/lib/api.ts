const API_URL = "http://localhost:3000";

export async function fetchRuns(): Promise<Run[]> {
  const res = await fetch(`${API_URL}/runs`);
  if (!res.ok) throw new Error(`Failed to fetch runs: ${res.status}`);
  return res.json();
}

export async function fetchRun(id: number): Promise<RunDetail> {
  const res = await fetch(`${API_URL}/runs/${id}`);
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

export interface TestResult {
  id: number;
  spec_id: number;
  title: string;
  full_title: string;
  status: "passed" | "failed" | "skipped" | "pending";
  duration_ms: number;
  error_message: string | null;
  error_stack: string | null;
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
  test_title: string;
  file_path: string;
  run_ids: number[];
}

export async function fetchErrors(): Promise<ErrorGroup[]> {
  const res = await fetch(`${API_URL}/errors`);
  if (!res.ok) throw new Error(`Failed to fetch errors: ${res.status}`);
  return res.json();
}

export async function fetchStats(): Promise<DashboardStats> {
  const res = await fetch(`${API_URL}/stats`);
  if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`);
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
