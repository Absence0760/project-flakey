import { expect, test, type Page } from "../fixtures/test";

/**
 * /releases/<id> — readiness MATH under mixed test states.
 *
 * INVARIANT PROTECTED
 * ===================
 * The release verdict must TRACK THE UNDERLYING TEST DATA, not just the
 * existence of links. Wiring a run/manual-test to a release is not enough:
 * the two AUTO-RULED checklist items
 *
 *   - "All critical tests passing"           (RULE_CRITICAL_TESTS_PASSING)
 *   - "Manual regression test suite executed" (RULE_MANUAL_REGRESSION_EXECUTED)
 *
 * are server-computed (NOT user-toggleable) and must flip with the real
 * pass/fail state of the linked runs and the most-recent manual session.
 * A regression where the rule silently reports "met" regardless of failures
 * (or never flips green once the data is clean) would let a broken build sign
 * off — exactly the failure this gate exists to prevent. So we drive BOTH
 * directions on independent, freshly-created releases:
 *
 *   (a) BLOCKED — a linked run with failed>0 (deterministically ingested) +
 *       a failing manual session result. Assert: the "All critical tests
 *       passing" auto-item is UNCHECKED, the readiness verdict shows a
 *       blocker (NOT "Ready to ship"), and "Sign off release" is disabled
 *       with the gating hint visible.
 *
 *   (b) MET — a clean passing run (failed=0) flips "All critical tests
 *       passing" to CHECKED with its passing auto_details; and a fully-passed
 *       COMPLETED manual session flips "Manual regression test suite
 *       executed" to CHECKED.
 *
 * Each case creates its OWN fresh release (DEFAULT_CHECKLIST, two auto rules)
 * and ingests its OWN run + manual tests in the worker's tenant — nothing
 * depends on additive/polluting seed rows.
 *
 * DETERMINISM
 * ===========
 * No sleeps / arbitrary timeouts / retries / loosened assertions. Setup is
 * done via the documented REST API (deterministic failed-counts and session
 * statuses you cannot control through the run/test pickers). After each
 * mutation we re-goto the page and wait on a REAL signal: the release heading,
 * the readiness verdict pill text, and the specific auto-item checkbox's
 * `checked` property. The auto checkbox is `disabled` (toggleItem early-returns
 * for auto items), so we assert its checked STATE — we never click it. We gate
 * cold loads on the route's `data-ready="true"` signal (set once load() has
 * settled release + readiness + sessions), then assert the specific verdict.
 */

const API = "http://localhost:3000";

// Checklist labels (DEFAULT_CHECKLIST, backend/src/routes/releases.ts:48-49).
// These are the *checklist* labels (differ from the readiness *rule* names).
const CRITICAL_ITEM = "All critical tests passing";
const MANUAL_ITEM = "Manual regression test suite executed";

async function getToken(page: Page): Promise<string> {
  // Caller must already be on an (app)/* route so restoreAuth() has populated
  // localStorage before we read the token.
  const token = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
  if (!token) throw new Error("bt_token missing — sign-in fixture broken?");
  return token;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function createRelease(page: Page, token: string): Promise<number> {
  const version = `e2e-rdy-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
  const res = await page.request.post(`${API}/releases`, {
    headers: authHeaders(token),
    // OMIT `items` → backend injects DEFAULT_CHECKLIST (the two auto-rule items
    // we assert on). releases.ts:499.
    data: { version, name: "e2e readiness math" },
  });
  expect(res.status(), "POST /releases should return 2xx").toBeLessThan(400);
  return (await res.json()).id;
}

async function deleteRelease(page: Page, token: string, id: number): Promise<void> {
  await page.request
    .delete(`${API}/releases/${id}`, { headers: { Authorization: `Bearer ${token}` } })
    .catch(() => {});
}

/**
 * Ingest an automated run with an exact failed/passed count via POST
 * /runs/upload (multipart, single `payload` JSON field). `stats.failed` is
 * what evaluateCriticalTestsPassing() reads — met=false when any linked run
 * has failed>0. Returns the new run id.
 */
async function uploadRun(
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
      suite_name: `e2e-readiness-${ciRunId}`,
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
        title: "readiness fixture",
        stats: { total, passed: opts.passed, failed: opts.failed, skipped: 0, duration_ms: 10 },
        tests,
      },
    ],
  };
  const res = await page.request.post(`${API}/runs/upload`, {
    // No Content-Type — multipart sets it.
    headers: { Authorization: `Bearer ${token}` },
    multipart: { payload: JSON.stringify(payload) },
  });
  if (!res.ok()) throw new Error(`/runs/upload: ${res.status()} ${await res.text()}`);
  return (await res.json()).id as number;
}

async function deleteRun(page: Page, token: string, id: number): Promise<void> {
  await page.request
    .delete(`${API}/runs/${id}`, { headers: { Authorization: `Bearer ${token}` } })
    .catch(() => {});
}

async function linkRun(page: Page, token: string, releaseId: number, runId: number): Promise<void> {
  const res = await page.request.post(`${API}/releases/${releaseId}/runs`, {
    headers: authHeaders(token),
    data: { run_id: runId },
  });
  expect(res.status(), "POST /releases/:id/runs should return 2xx").toBeLessThan(400);
}

async function createManualTest(page: Page, token: string, title: string): Promise<number> {
  const res = await page.request.post(`${API}/manual-tests`, {
    headers: authHeaders(token),
    data: { title, priority: "high" },
  });
  expect(res.status(), "POST /manual-tests should return 2xx").toBeLessThan(400);
  return (await res.json()).id as number;
}

async function linkManualTest(
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

async function startSession(page: Page, token: string, releaseId: number): Promise<number> {
  const res = await page.request.post(`${API}/releases/${releaseId}/sessions`, {
    headers: authHeaders(token),
    data: { mode: "full", label: "e2e regression" },
  });
  expect(res.status(), "POST /releases/:id/sessions should return 201").toBe(201);
  return (await res.json()).id as number;
}

async function recordResult(
  page: Page,
  token: string,
  releaseId: number,
  sessionId: number,
  testId: number,
  status: "passed" | "failed" | "blocked" | "skipped",
): Promise<void> {
  const res = await page.request.post(
    `${API}/releases/${releaseId}/sessions/${sessionId}/results/${testId}`,
    { headers: authHeaders(token), data: { status } },
  );
  expect(res.status(), "POST result should return 2xx").toBeLessThan(400);
}

/** Land on the detail page and wait on the route's data-ready signal. */
async function gotoRelease(page: Page, id: number): Promise<void> {
  await page.goto(`/releases/${id}`);
  // data-ready flips to "true" once load() settles release + readiness +
  // sessions (and the active session detail) — a single deterministic
  // load-complete gate. The readiness panel is mounted by then.
  await expect(page.locator('.page[data-ready="true"]')).toBeVisible();
}

/** The <li> for an auto-ruled checklist item, scoped by its label text. */
function autoItem(page: Page, label: string) {
  return page.locator("section.checklist-section ul.items > li.auto").filter({
    has: page.locator(".item-label", { hasText: label }),
  });
}

test.describe("/releases/<id> — readiness math tracks test state", () => {
  test("(a) failing run + failing manual session → BLOCKED, sign-off disabled", async ({ page }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);

    const releaseId = await createRelease(page, token);
    // Deterministic FAILING automated signal: 1 failed, 2 passed.
    const runId = await uploadRun(page, token, { failed: 1, passed: 2 });
    // Two manual tests so the session does NOT auto-complete after one fail
    // (auto-complete fires only when no not_run rows remain). We record one
    // failure and leave the rule unmet.
    const mt1 = await createManualTest(page, token, `e2e fail mt ${Date.now()}`);
    const mt2 = await createManualTest(page, token, `e2e pass mt ${Date.now()}`);

    try {
      await linkRun(page, token, releaseId, runId);
      await linkManualTest(page, token, releaseId, mt1);
      await linkManualTest(page, token, releaseId, mt2);

      const sessionId = await startSession(page, token, releaseId);
      await recordResult(page, token, releaseId, sessionId, mt1, "failed");
      await recordResult(page, token, releaseId, sessionId, mt2, "passed");

      await gotoRelease(page, releaseId);

      // Verdict: NOT ready. The blocked pill is present, the ready pill is not.
      await expect(page.locator("section.readiness .blocked-pill")).toBeVisible();
      await expect(page.locator("section.readiness .blocked-pill")).toContainText("blocker(s)");
      await expect(page.locator("section.readiness .ready-pill")).toHaveCount(0);
      // The readiness section must NOT carry the .ready class.
      await expect(page.locator("section.readiness")).not.toHaveClass(/(^|\s)ready(\s|$)/);

      // Automated-runs card reflects the failure deterministically (1 failed of 3).
      const runsCard = page.locator("section.readiness .readiness-card", {
        has: page.locator(".card-title", { hasText: "Automated runs" }),
      });
      await expect(runsCard.locator(".card-big")).toHaveText("2/3 passing");
      await expect(runsCard.locator(".card-sub")).toContainText("1 failed");

      // The "All critical tests passing" auto-item is UNCHECKED (run failed>0).
      const critical = autoItem(page, CRITICAL_ITEM);
      await expect(critical).toHaveCount(1);
      await expect(critical.locator('input[type="checkbox"]')).not.toBeChecked();
      await expect(critical).not.toHaveClass(/(^|\s)checked(\s|$)/);
      // It's an auto item: the checkbox is disabled (server-computed, not toggleable).
      await expect(critical.locator('input[type="checkbox"]')).toBeDisabled();

      // The "Manual regression test suite executed" auto-item is UNCHECKED too.
      const manual = autoItem(page, MANUAL_ITEM);
      await expect(manual).toHaveCount(1);
      await expect(manual.locator('input[type="checkbox"]')).not.toBeChecked();

      // Sign-off is gated: button disabled + the exact gating hint shown.
      const signOff = page.locator("section.actions-section button.btn-primary", {
        hasText: "Sign off release",
      });
      await expect(signOff).toBeVisible();
      await expect(signOff).toBeDisabled();
      // The actions section renders several <p class="hint"> (the cancel
      // explainer is always present), so scope to the gating hint by its exact
      // text rather than matching the bare class.
      await expect(
        page.locator("section.actions-section p.hint", {
          hasText: "Complete all required checklist items to sign off.",
        }),
      ).toBeVisible();
    } finally {
      await deleteRelease(page, token, releaseId);
      await deleteRun(page, token, runId);
    }
  });

  test("(b) clean run + completed all-pass session → both auto-rules CHECKED", async ({ page }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);

    const releaseId = await createRelease(page, token);
    // Deterministic CLEAN automated signal: 0 failed, 3 passed.
    const runId = await uploadRun(page, token, { failed: 0, passed: 3 });
    // A single linked manual test: recording its pass leaves NO not_run rows,
    // so the session AUTO-COMPLETES (session_completed:true) — exactly the
    // "completed + all clean" state RULE_MANUAL_REGRESSION_EXECUTED needs to
    // go green (an in-progress session never flips green).
    const mt1 = await createManualTest(page, token, `e2e clean mt ${Date.now()}`);

    try {
      await linkRun(page, token, releaseId, runId);
      await linkManualTest(page, token, releaseId, mt1);

      const sessionId = await startSession(page, token, releaseId);
      await recordResult(page, token, releaseId, sessionId, mt1, "passed");

      // Confirm via the readiness JSON that the session completed clean before
      // asserting the UI — a real backend signal, not a guess.
      const readinessRes = await page.request.get(`${API}/releases/${releaseId}/readiness`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(readinessRes.ok()).toBeTruthy();
      const readiness = await readinessRes.json();
      expect(readiness.rules.critical_tests_passing.met).toBe(true);
      expect(readiness.rules.manual_regression_executed.met).toBe(true);

      await gotoRelease(page, releaseId);

      // Automated-runs card: clean.
      const runsCard = page.locator("section.readiness .readiness-card", {
        has: page.locator(".card-title", { hasText: "Automated runs" }),
      });
      await expect(runsCard.locator(".card-big")).toHaveText("3/3 passing");
      await expect(runsCard.locator(".card-sub")).toContainText("0 failed");

      // Manual-tests card: 1/1 passed.
      const manualCard = page.locator("section.readiness .readiness-card", {
        has: page.locator(".card-title", { hasText: "Manual tests" }),
      });
      await expect(manualCard.locator(".card-big")).toHaveText("1/1 passed");

      // "All critical tests passing" auto-item FLIPPED to CHECKED, with its
      // passing auto_details ("... passing across ...").
      const critical = autoItem(page, CRITICAL_ITEM);
      await expect(critical).toHaveCount(1);
      await expect(critical.locator('input[type="checkbox"]')).toBeChecked();
      await expect(critical).toHaveClass(/(^|\s)checked(\s|$)/);
      await expect(critical.locator(".auto-details")).toContainText("passing");

      // "Manual regression test suite executed" auto-item FLIPPED to CHECKED,
      // with its "executed cleanly in session #..." auto_details.
      const manual = autoItem(page, MANUAL_ITEM);
      await expect(manual).toHaveCount(1);
      await expect(manual.locator('input[type="checkbox"]')).toBeChecked();
      await expect(manual).toHaveClass(/(^|\s)checked(\s|$)/);
      await expect(manual.locator(".auto-details")).toContainText("executed cleanly in session");
    } finally {
      await deleteRelease(page, token, releaseId);
      await deleteRun(page, token, runId);
    }
  });
});
