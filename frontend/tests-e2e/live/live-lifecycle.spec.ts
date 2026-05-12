import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * Live test lifecycle — the contract:
 *
 *   1. POST /live/start                    → run created, registered, LIVE
 *   2. POST events: spec.started + many test.started      → all rows render as
 *      pending (the planned manifest, visible up front)
 *   3. POST events: test.passed/failed for first test     → row flips
 *   4. POST screenshot/snapshot for that test (mid-run)   → artifacts attach
 *      to the test row; visible in ErrorModal
 *   5. POST events: test.passed/failed for the next test  → row flips
 *      …repeat for every test…
 *   6. POST run.finished                    → LIVE drops, status pill flips
 *
 * Edge cases covered:
 *   - Mid-run abort: process killed mid-run → /live/<id>/abort → all
 *     remaining pending tests must transition out of pending (the bug
 *     fix in routes/live.ts:transitionPendingTestsAfterAbort)
 *   - Stale detection: no events for FLAKEY_LIVE_TIMEOUT_MS → backend
 *     auto-aborts AND transitions pending rows
 *   - Skipped tests: test.skipped event marks the row
 *
 * Each test creates a fresh live run, drives the lifecycle, asserts at
 * each transition, then cleans up via DELETE /runs/:id.
 */

const POLL_TIMEOUT = 10_000;

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

async function startLive(page: Page, token: string, suite: string): Promise<number> {
  const res = await page.request.post("http://localhost:3000/live/start", {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: { suite, branch: "main", commitSha: "lifecycle" },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id as number;
}

async function postEvent(
  page: Page,
  token: string,
  runId: number,
  event: Record<string, unknown>,
): Promise<void> {
  const res = await page.request.post(`http://localhost:3000/live/${runId}/events`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: event,
  });
  expect(res.status(), `event ${event.type} should accept`).toBe(200);
}

async function deleteRun(page: Page, token: string, runId: number): Promise<void> {
  await page.request.delete(`http://localhost:3000/runs/${runId}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

async function bootstrap(
  page: Page,
  suite: string,
): Promise<{ token: string; runId: number }> {
  await page.goto("/dashboard");
  const token = await getToken(page);
  const runId = await startLive(page, token, `${suite}-${Date.now().toString(36)}`);
  await page.goto(`/runs/${runId}`);
  await expect(
    page.getByRole("heading", { name: new RegExp(`^Run #${runId}\\s*$`) }),
  ).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(page.locator(".live-badge")).toBeVisible({ timeout: POLL_TIMEOUT });
  return { token, runId };
}

test.describe("live lifecycle — full happy path (planned manifest → run order → finish)", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("emits ALL test.started up front → pending manifest visible → tests flip in order → run.finished drops LIVE", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { token, runId } = await bootstrap(page, "live-lifecycle");
    const specPath = "tests/lifecycle/manifest.spec.ts";
    const planned = ["alpha test", "beta test", "gamma test"] as const;

    // 1) Spec begins.
    await postEvent(page, token, runId, { type: "spec.started", spec: specPath });

    // 2) PLANNED MANIFEST — emit test.started for ALL tests up front.
    //    The user contract: "I should see all the expected tests to run".
    for (const t of planned) {
      await postEvent(page, token, runId, { type: "test.started", spec: specPath, test: t });
    }

    // All three rows render as pending (the dashboard's 3s poll picks
    // them up). Each .test-status-dot.pending dot is the in-progress
    // visual cue.
    await expect.poll(
      async () => await page.locator(".test-status-dot.pending").count(),
      { timeout: 15_000, message: "expected 3 pending rows visible up front" },
    ).toBeGreaterThanOrEqual(3);

    // 3) RUN ORDER — flip them one by one. After each, the previous
    //    test's dot transitions terminal but later tests stay pending.
    await postEvent(page, token, runId, {
      type: "test.passed", spec: specPath, test: planned[0], duration_ms: 100,
    });
    await expect.poll(
      async () => await page.locator(".test-status-dot.passed").count(),
      { timeout: POLL_TIMEOUT, message: "first test should flip to passed" },
    ).toBeGreaterThanOrEqual(1);
    // The other two stay pending.
    await expect.poll(
      async () => await page.locator(".test-status-dot.pending").count(),
      { timeout: 5_000 },
    ).toBeGreaterThanOrEqual(2);

    // 4) Second flips fail.
    await postEvent(page, token, runId, {
      type: "test.failed",
      spec: specPath,
      test: planned[1],
      duration_ms: 250,
      error: "AssertionError: simulated failure mid-run",
    });
    await expect.poll(
      async () => await page.locator(".test-status-dot.failed").count(),
      { timeout: POLL_TIMEOUT },
    ).toBeGreaterThanOrEqual(1);
    await expect.poll(
      async () => await page.locator(".test-status-dot.pending").count(),
      { timeout: 5_000 },
    ).toBeGreaterThanOrEqual(1);

    // 5) Third — skipped.
    await postEvent(page, token, runId, {
      type: "test.skipped", spec: specPath, test: planned[2],
    });

    // 6) Run.finished — LIVE pill drops.
    await postEvent(page, token, runId, {
      type: "run.finished",
      stats: { total: 3, passed: 1, failed: 1, skipped: 1 },
    });
    await expect(page.locator(".live-badge")).toHaveCount(0, { timeout: POLL_TIMEOUT });

    // No row should remain in pending state.
    await expect(page.locator(".test-status-dot.pending")).toHaveCount(0);

    await deleteRun(page, token, runId);
  });
});

test.describe("live lifecycle — mid-run abort transitions pending tests out of pending", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("aborting a run with pending tests transitions them to terminal state (no zombie 'running' rows)", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const { token, runId } = await bootstrap(page, "live-abort-pending");
    const specPath = "tests/lifecycle/abort.spec.ts";

    await postEvent(page, token, runId, { type: "spec.started", spec: specPath });
    await postEvent(page, token, runId, { type: "test.started", spec: specPath, test: "T1" });
    await postEvent(page, token, runId, { type: "test.started", spec: specPath, test: "T2" });
    // Only T1 finishes — T2 stays mid-flight when the run is aborted.
    await postEvent(page, token, runId, {
      type: "test.passed", spec: specPath, test: "T1", duration_ms: 50,
    });

    // Wait for the rows to land before aborting.
    await expect.poll(
      async () => await page.locator(".test-row").count(),
      { timeout: 15_000 },
    ).toBeGreaterThanOrEqual(2);

    // Abort.
    const abortRes = await page.request.post(`http://localhost:3000/live/${runId}/abort`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { reason: "process killed mid-run" },
    });
    expect(abortRes.status()).toBeLessThan(400);

    // LIVE drops.
    await expect(page.locator(".live-badge")).toHaveCount(0, { timeout: POLL_TIMEOUT });

    // The contract: NO test row should be left in pending state. The
    // route's transitionPendingTestsAfterAbort must have flipped T2
    // out of pending. Without that fix, T2's status-dot.pending would
    // persist forever.
    await expect.poll(
      async () => await page.locator(".test-status-dot.pending").count(),
      { timeout: 10_000, message: "no test should be left in 'pending' (zombie-running) state after an abort" },
    ).toBe(0);

    // T2 should now have an error_message indicating it was aborted.
    // Verify via the backend API directly so we don't depend on UI
    // collapse/expand flows.
    const detail = await page.request.get(`http://localhost:3000/runs/${runId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(detail.status()).toBe(200);
    const body = await detail.json();
    const allTests = (body.specs ?? []).flatMap((s: { tests: { title: string; status: string; error_message: string | null }[] }) => s.tests);
    const t2 = allTests.find((t: { title: string }) => t.title === "T2");
    expect(t2, "T2 should still exist post-abort").toBeTruthy();
    expect(t2.status, "T2 must NOT be pending").not.toBe("pending");
    expect(t2.error_message ?? "").toMatch(/aborted/i);

    await deleteRun(page, token, runId);
  });
});

test.describe("live lifecycle — stale detection auto-aborts a quiet run", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("a run that emits no events for FLAKEY_LIVE_TIMEOUT_MS gets auto-aborted, no pending zombies", async ({
    page,
  }) => {
    // The dev server uses the default 10-min stale window unless
    // FLAKEY_LIVE_TIMEOUT_MS is overridden. We can't wait 10 min in a
    // test; instead, drive the abort manually to exercise the SAME
    // code path that stale detection uses (abortRun() → transition).
    // The pure-stale-timer integration is exercised by backend unit
    // tests; here we only need to prove the UI handles the "abort
    // with pending rows" case identically regardless of who triggers
    // it.
    test.setTimeout(45_000);
    const { token, runId } = await bootstrap(page, "live-stale");
    const specPath = "tests/lifecycle/stale.spec.ts";

    await postEvent(page, token, runId, { type: "spec.started", spec: specPath });
    await postEvent(page, token, runId, { type: "test.started", spec: specPath, test: "stuck-test" });

    await expect.poll(
      async () => await page.locator(".test-status-dot.pending").count(),
      { timeout: 15_000 },
    ).toBeGreaterThanOrEqual(1);

    // Trigger the same abortRun() path the stale timer uses.
    await page.request.post(`http://localhost:3000/live/${runId}/abort`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { reason: "Run stopped unexpectedly — the test process may have been killed or the terminal was closed." },
    });

    await expect(page.locator(".live-badge")).toHaveCount(0, { timeout: POLL_TIMEOUT });
    await expect.poll(
      async () => await page.locator(".test-status-dot.pending").count(),
      { timeout: 10_000 },
    ).toBe(0);

    await deleteRun(page, token, runId);
  });
});

test.describe("live lifecycle — screenshot attached mid-run lands on the test row", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("POST /live/<id>/screenshot mid-run attaches the file path to the matching test", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    const { token, runId } = await bootstrap(page, "live-screenshot");
    const specPath = "tests/lifecycle/screenshot.spec.ts";
    const testTitle = "should capture a screenshot on failure";

    await postEvent(page, token, runId, { type: "spec.started", spec: specPath });
    await postEvent(page, token, runId, { type: "test.started", spec: specPath, test: testTitle });

    // Mid-run screenshot upload via multipart. The 1×1 PNG below is a
    // valid minimal PNG — enough for the streaming endpoint's mime
    // sniff + storage write.
    const minimalPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    const ssRes = await page.request.post(
      `http://localhost:3000/live/${runId}/screenshot`,
      {
        headers: { Authorization: `Bearer ${token}` },
        multipart: {
          screenshot: { name: "live-shot.png", mimeType: "image/png", buffer: minimalPng },
          spec: specPath,
          testTitle,
        },
      },
    );
    expect(ssRes.status(), "screenshot upload should accept").toBe(200);

    // Test then completes (failed, so the screenshot would be the
    // failure capture in real usage).
    await postEvent(page, token, runId, {
      type: "test.failed",
      spec: specPath,
      test: testTitle,
      duration_ms: 300,
      error: "AssertionError: simulated for screenshot test",
    });

    // Backend API: the test row should now have ≥1 entry in
    // screenshot_paths.
    await expect.poll(async () => {
      const r = await page.request.get(`http://localhost:3000/runs/${runId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await r.json();
      const tests = (body.specs ?? []).flatMap((s: { tests: { title: string; screenshot_paths?: string[] }[] }) => s.tests);
      const t = tests.find((x: { title: string }) => x.title === testTitle);
      return t?.screenshot_paths?.length ?? 0;
    }, { timeout: 15_000, message: "screenshot_paths should grow after the streaming upload" }).toBeGreaterThanOrEqual(1);

    await postEvent(page, token, runId, { type: "run.finished" });
    await deleteRun(page, token, runId);
  });
});

test.describe("live lifecycle — adapter-shape coverage (Cypress, Playwright, WDIO)", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("Cypress/Mocha adapter: full per-spec lifecycle for 3 tests + run.finished clears LIVE", async ({
    page,
  }) => {
    test.setTimeout(75_000);
    const { token, runId } = await bootstrap(page, "live-cypress-lifecycle");
    const specPath = "cypress/e2e/auth/full-lifecycle.cy.ts";

    // Cypress's mocha adapter emits run.started, then per-spec:
    // spec.started → test.started + test.passed/failed → spec.finished → run.finished.
    await postEvent(page, token, runId, { type: "run.started" });
    await postEvent(page, token, runId, { type: "spec.started", spec: specPath });

    const titles = [
      "Auth flow > should sign in",
      "Auth flow > should reject bad creds",
      "Auth flow > should remember session",
    ];
    for (const t of titles) {
      await postEvent(page, token, runId, { type: "test.started", spec: specPath, test: t });
    }
    // All visible as pending.
    await expect.poll(
      async () => await page.locator(".test-status-dot.pending").count(),
      { timeout: 15_000 },
    ).toBeGreaterThanOrEqual(3);

    await postEvent(page, token, runId, {
      type: "test.passed", spec: specPath, test: titles[0], duration_ms: 800,
    });
    await postEvent(page, token, runId, {
      type: "test.failed",
      spec: specPath,
      test: titles[1],
      duration_ms: 1200,
      error: "Timeout: locator(.error-msg) not visible after 4000ms",
    });
    await postEvent(page, token, runId, {
      type: "test.passed", spec: specPath, test: titles[2], duration_ms: 600,
    });
    await postEvent(page, token, runId, {
      type: "spec.finished", spec: specPath,
      stats: { total: 3, passed: 2, failed: 1, skipped: 0 },
    });
    await postEvent(page, token, runId, { type: "run.finished" });

    await expect(page.locator(".live-badge")).toHaveCount(0, { timeout: POLL_TIMEOUT });
    await expect(page.locator(".test-status-dot.pending")).toHaveCount(0);

    await deleteRun(page, token, runId);
  });

  test("Playwright adapter (no spec.started): rows materialize on test.started, flip on test.passed/failed", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const { token, runId } = await bootstrap(page, "live-playwright-lifecycle");
    const specPath = "tests/lifecycle/pw.spec.ts";

    // Playwright DOES NOT emit spec.started/spec.finished — the spec
    // row is materialised lazily when the first test.started event
    // includes the spec path. Verify that path works end-to-end.
    await postEvent(page, token, runId, {
      type: "run.started",
      stats: { total: 2, passed: 0, failed: 0, skipped: 0 },
    });
    await postEvent(page, token, runId, { type: "test.started", spec: specPath, test: "PW#1" });
    await postEvent(page, token, runId, { type: "test.started", spec: specPath, test: "PW#2" });

    // Spec row mounts even though we never sent spec.started.
    await expect.poll(
      async () => await page.locator(".spec-section").count(),
      { timeout: 15_000 },
    ).toBeGreaterThanOrEqual(1);
    await expect.poll(
      async () => await page.locator(".test-status-dot.pending").count(),
      { timeout: 5_000 },
    ).toBeGreaterThanOrEqual(2);

    await postEvent(page, token, runId, {
      type: "test.passed", spec: specPath, test: "PW#1", duration_ms: 700,
    });
    await postEvent(page, token, runId, {
      type: "test.passed", spec: specPath, test: "PW#2", duration_ms: 900,
    });
    await postEvent(page, token, runId, { type: "run.finished" });

    await expect(page.locator(".live-badge")).toHaveCount(0, { timeout: POLL_TIMEOUT });
    await expect(page.locator(".test-status-dot.pending")).toHaveCount(0);

    await deleteRun(page, token, runId);
  });

  test("WebdriverIO adapter (no test.started): rows surface directly as terminal states", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    const { token, runId } = await bootstrap(page, "live-wdio-lifecycle");
    const specPath = "test/specs/wdio-lifecycle.spec.js";

    // WDIO has NO onTestStart hook — only onTestPass/Fail/Skip. So
    // pending rows never appear; results land as terminal states.
    await postEvent(page, token, runId, { type: "run.started" });
    await postEvent(page, token, runId, { type: "spec.started", spec: specPath });
    await postEvent(page, token, runId, {
      type: "test.passed", spec: specPath, test: "wdio sign-in", duration_ms: 980,
    });
    await postEvent(page, token, runId, {
      type: "test.failed",
      spec: specPath,
      test: "wdio empty-pwd",
      duration_ms: 540,
      error: "AssertionError: empty password silently accepted",
    });
    await postEvent(page, token, runId, {
      type: "test.skipped", spec: specPath, test: "wdio remember-me",
    });
    await postEvent(page, token, runId, { type: "run.finished" });

    await expect(page.locator(".live-badge")).toHaveCount(0, { timeout: POLL_TIMEOUT });
    // Crucially: no pending rows at any point during this lifecycle —
    // WDIO's adapter never emits test.started.
    await expect(page.locator(".test-status-dot.pending")).toHaveCount(0);
    // ≥1 passed and ≥1 failed dot must be visible.
    await expect.poll(
      async () => await page.locator(".test-status-dot.passed").count(),
      { timeout: POLL_TIMEOUT },
    ).toBeGreaterThanOrEqual(1);
    await expect.poll(
      async () => await page.locator(".test-status-dot.failed").count(),
      { timeout: POLL_TIMEOUT },
    ).toBeGreaterThanOrEqual(1);

    await deleteRun(page, token, runId);
  });
});
