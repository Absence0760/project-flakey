import { expect, type Page } from "../fixtures/test";

/**
 * Shared setup helpers for the release-readiness e2e specs.
 *
 * NOT a spec file (no `.spec.ts` suffix → Playwright's default testMatch
 * skips it). These wrap the documented REST API so each spec sets up its own
 * deterministic state in the worker's own tenant — failed/passed run counts
 * and session statuses you cannot control through the run/test pickers.
 *
 * All calls attach the Bearer token explicitly: `page.request` shares the
 * browser's cookies but NOT the in-localStorage auth token this app uses.
 */

export const API = "http://localhost:3000";

export async function getToken(page: Page): Promise<string> {
  // Caller must already be on an (app)/* route so restoreAuth() has populated
  // localStorage before we read the token.
  const token = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
  if (!token) throw new Error("bt_token missing — sign-in fixture broken?");
  return token;
}

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export async function createRelease(
  page: Page,
  token: string,
  name = "e2e edge case",
): Promise<number> {
  const version = `e2e-edge-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
  const res = await page.request.post(`${API}/releases`, {
    headers: authHeaders(token),
    // OMIT `items` → backend injects DEFAULT_CHECKLIST (the two auto-rule items).
    data: { version, name },
  });
  expect(res.status(), "POST /releases should return 2xx").toBeLessThan(400);
  return (await res.json()).id as number;
}

export async function deleteRelease(page: Page, token: string, id: number): Promise<void> {
  await page.request.delete(`${API}/releases/${id}`, { headers: bearer(token) }).catch(() => {});
}

/**
 * Ingest an automated run with an exact failed/passed count via POST
 * /runs/upload (multipart, single `payload` JSON field). `stats.failed` is
 * what evaluateCriticalTestsPassing() reads.
 */
export async function uploadRun(
  page: Page,
  token: string,
  opts: { failed: number; passed: number },
): Promise<number> {
  const ciRunId = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const total = opts.failed + opts.passed;
  const tests = [
    ...Array.from({ length: opts.passed }, (_, i) => ({
      title: `pass ${i}`,
      full_title: `pass ${i}`,
      status: "passed",
      duration_ms: 5,
      screenshot_paths: [],
    })),
    ...Array.from({ length: opts.failed }, (_, i) => ({
      title: `fail ${i}`,
      full_title: `fail ${i}`,
      status: "failed",
      duration_ms: 5,
      error: { message: `boom ${i}`, stack: null },
      screenshot_paths: [],
    })),
  ];
  const payload = {
    meta: {
      suite_name: `e2e-edge-${ciRunId}`,
      branch: "main",
      commit_sha: `sha-${ciRunId}`,
      ci_run_id: ciRunId,
      started_at: "2026-06-08T00:00:00Z",
      finished_at: "2026-06-08T00:00:10Z",
      reporter: "mochawesome",
    },
    stats: { total, passed: opts.passed, failed: opts.failed, skipped: 0, pending: 0, duration_ms: 10 },
    specs: [
      {
        file_path: "spec.cy.ts",
        title: "edge fixture",
        stats: { total, passed: opts.passed, failed: opts.failed, skipped: 0, duration_ms: 10 },
        tests,
      },
    ],
  };
  const res = await page.request.post(`${API}/runs/upload`, {
    headers: bearer(token),
    multipart: { payload: JSON.stringify(payload) },
  });
  if (!res.ok()) throw new Error(`/runs/upload: ${res.status()} ${await res.text()}`);
  return (await res.json()).id as number;
}

export async function deleteRun(page: Page, token: string, id: number): Promise<void> {
  await page.request.delete(`${API}/runs/${id}`, { headers: bearer(token) }).catch(() => {});
}

/**
 * Start a LIVE run (POST /live/start) — registers the run in the live-events
 * bus so it can subsequently be aborted. A run ingested via /runs/upload was
 * never live, so abortRun() no-ops on it (it guards on liveEvents.hasRun); only
 * a run started here can produce a real `run.aborted` event.
 */
export async function startLiveRun(
  page: Page,
  token: string,
  suite = `e2e-live-${Date.now().toString(36)}`,
): Promise<number> {
  const res = await page.request.post(`${API}/live/start`, {
    headers: authHeaders(token),
    data: { suite, branch: "main", commitSha: "e2e-live" },
  });
  expect(res.status(), "POST /live/start should return 201").toBe(201);
  return (await res.json()).id as number;
}

/**
 * Mark an already-uploaded run as aborted (persists a `run.aborted` live_event)
 * — the signal evaluateCriticalTestsPassing() treats as "rerun required" even
 * when the run's captured stats show zero failures.
 */
export async function abortRun(page: Page, token: string, runId: number): Promise<void> {
  const res = await page.request.post(`${API}/live/${runId}/abort`, {
    headers: authHeaders(token),
    data: { reason: "e2e: simulated CI kill" },
  });
  expect(res.status(), "POST /live/:id/abort should return 2xx").toBeLessThan(400);
}

export async function linkRun(
  page: Page,
  token: string,
  releaseId: number,
  runId: number,
): Promise<void> {
  const res = await page.request.post(`${API}/releases/${releaseId}/runs`, {
    headers: authHeaders(token),
    data: { run_id: runId },
  });
  expect(res.status(), "POST /releases/:id/runs should return 2xx").toBeLessThan(400);
}

export async function createManualTest(
  page: Page,
  token: string,
  title: string,
  priority = "high",
): Promise<number> {
  const res = await page.request.post(`${API}/manual-tests`, {
    headers: authHeaders(token),
    data: { title, priority },
  });
  expect(res.status(), "POST /manual-tests should return 2xx").toBeLessThan(400);
  return (await res.json()).id as number;
}

export async function linkManualTest(
  page: Page,
  token: string,
  releaseId: number,
  manualTestId: number,
): Promise<void> {
  const res = await page.request.post(`${API}/releases/${releaseId}/manual-tests`, {
    headers: authHeaders(token),
    data: { manual_test_id: manualTestId },
  });
  expect(res.status(), "POST /releases/:id/manual-tests should return 2xx").toBeLessThan(400);
}

export async function startSession(
  page: Page,
  token: string,
  releaseId: number,
  mode = "full",
): Promise<number> {
  const res = await page.request.post(`${API}/releases/${releaseId}/sessions`, {
    headers: authHeaders(token),
    data: { mode, label: "e2e edge session" },
  });
  expect(res.status(), "POST /releases/:id/sessions should return 201").toBe(201);
  return (await res.json()).id as number;
}

type ResultStatus = "passed" | "failed" | "blocked" | "skipped" | "not_run";

/** Record one session result. Returns the response body (incl. session_completed). */
export async function recordResult(
  page: Page,
  token: string,
  releaseId: number,
  sessionId: number,
  testId: number,
  status: ResultStatus,
): Promise<{ session_completed?: boolean }> {
  const res = await page.request.post(
    `${API}/releases/${releaseId}/sessions/${sessionId}/results/${testId}`,
    { headers: authHeaders(token), data: { status } },
  );
  expect(res.status(), `POST result (${status}) should return 2xx`).toBeLessThan(400);
  return res.json();
}

/** Start a session, returning the full response (for asserting status codes). */
export async function startSessionRes(
  page: Page,
  token: string,
  releaseId: number,
  mode = "full",
) {
  return page.request.post(`${API}/releases/${releaseId}/sessions`, {
    headers: authHeaders(token),
    data: { mode, label: "e2e session" },
  });
}

/** PATCH a session (status/label/target_date). Returns the response. */
export async function patchSession(
  page: Page,
  token: string,
  releaseId: number,
  sessionId: number,
  body: Record<string, unknown>,
) {
  return page.request.patch(`${API}/releases/${releaseId}/sessions/${sessionId}`, {
    headers: authHeaders(token),
    data: body,
  });
}

/** Attach a requirement (ref_key) to a manual test, optionally with a title. */
export async function attachRequirement(
  page: Page,
  token: string,
  manualTestId: number,
  refKey: string,
  refTitle?: string,
): Promise<void> {
  const res = await page.request.post(`${API}/manual-tests/${manualTestId}/requirements`, {
    headers: authHeaders(token),
    data: { ref_key: refKey, ...(refTitle ? { ref_title: refTitle } : {}) },
  });
  expect(res.status(), "POST requirement should return 201").toBe(201);
}

/** GET the release's requirements-coverage rollup. */
export async function getRequirements(
  page: Page,
  token: string,
  releaseId: number,
): Promise<any[]> {
  const res = await page.request.get(`${API}/releases/${releaseId}/requirements`, {
    headers: bearer(token),
  });
  expect(res.ok(), "GET requirements should be ok").toBeTruthy();
  return res.json();
}

/** The signed-in user's own id (via GET /auth/me). */
export async function getMyUserId(page: Page, token: string): Promise<number> {
  const res = await page.request.get(`${API}/auth/me`, { headers: bearer(token) });
  expect(res.ok(), "GET /auth/me should be ok").toBeTruthy();
  return (await res.json()).user.id as number;
}

/** Assign (or, with null, un-assign) a tester to a test-in-session. Returns the response. */
export async function assignTester(
  page: Page,
  token: string,
  releaseId: number,
  sessionId: number,
  testId: number,
  userId: number | null,
) {
  return page.request.post(
    `${API}/releases/${releaseId}/sessions/${sessionId}/results/${testId}/assign`,
    { headers: authHeaders(token), data: { user_id: userId } },
  );
}

/** Full session detail (results incl. assigned_to_email). */
export async function getSessionDetail(
  page: Page,
  token: string,
  releaseId: number,
  sessionId: number,
): Promise<any> {
  const res = await page.request.get(`${API}/releases/${releaseId}/sessions/${sessionId}`, {
    headers: bearer(token),
  });
  expect(res.ok(), "GET session detail should be ok").toBeTruthy();
  return res.json();
}

export async function unlinkManualTest(
  page: Page,
  token: string,
  releaseId: number,
  manualTestId: number,
): Promise<void> {
  const res = await page.request.delete(
    `${API}/releases/${releaseId}/manual-tests/${manualTestId}`,
    { headers: bearer(token) },
  );
  expect(res.status(), "DELETE manual-test link should 2xx").toBeLessThan(400);
}

/** Defer a failed/blocked result as a known issue (optionally with a ref). */
export async function acceptResult(
  page: Page,
  token: string,
  releaseId: number,
  sessionId: number,
  testId: number,
  knownIssueRef?: string,
): Promise<void> {
  const res = await page.request.post(
    `${API}/releases/${releaseId}/sessions/${sessionId}/results/${testId}/accept`,
    { headers: authHeaders(token), data: knownIssueRef ? { known_issue_ref: knownIssueRef } : {} },
  );
  expect(res.status(), "POST .../accept should return 2xx").toBeLessThan(400);
}

export async function getReadiness(
  page: Page,
  token: string,
  releaseId: number,
): Promise<any> {
  const res = await page.request.get(`${API}/releases/${releaseId}/readiness`, {
    headers: bearer(token),
  });
  expect(res.ok(), "GET /releases/:id/readiness should be ok").toBeTruthy();
  return res.json();
}

/**
 * Land on the detail page and wait on the route's data-ready signal — set once
 * load() settles (release + readiness + sessions, resolved OR errored). Works
 * for the error state too (loading clears either way).
 */
export async function gotoReleaseReady(page: Page, id: number): Promise<void> {
  await page.goto(`/releases/${id}`);
  await expect(page.locator('.page[data-ready="true"]')).toBeVisible();
}

/** The <li> for an auto-ruled checklist item, scoped by its label text. */
export function autoChecklistItem(page: Page, label: string) {
  return page.locator("section.checklist-section ul.items > li.auto").filter({
    has: page.locator(".item-label", { hasText: label }),
  });
}

// DEFAULT_CHECKLIST auto-rule item labels (backend/src/routes/releases.ts).
export const CRITICAL_ITEM = "All critical tests passing";
export const MANUAL_ITEM = "Manual regression test suite executed";
