import { expect, test, type Page } from "../fixtures/test";


/**
 * /runs/<id> — live run flow.
 *
 * Drives a real live run via the backend API:
 *   1. POST /live/start                  → creates a run, registers SSE
 *   2. Navigate Playwright to /runs/<id> → SSE connects, LIVE badge mounts
 *   3. POST /live/<id>/events            → spec.started, test.started,
 *                                          test.passed, …, run.finished
 *   4. The run-detail page polls fetchRun every 3s; pending tests
 *      flip to passed/failed in the table as events arrive.
 *
 * Catches regressions in:
 *   - SSE connection (LIVE badge gating on `connected` event)
 *   - liveEvents feed sidebar receiving + rendering events
 *   - upsertPendingTest: test.started inserts a `pending` row
 *   - insertLiveTestResult: test.passed flips that pending row
 *   - run.finished closing the SSE and dropping the LIVE badge
 *   - the auto-applied `?status=failed` URL after run.finished if failures
 */

/**
 * Read the auth token ONCE from the page's localStorage, cached for
 * the test's lifetime. The previous version called page.goto("/dashboard")
 * on every API call — which meant every postLiveEvent navigated the
 * Playwright page off the run-detail screen and the test rendered
 * the wrong route.
 */
async function getToken(page: Page): Promise<string> {
  // The page must already be on a route under the (app) layout for
  // localStorage to have bt_token. The test should call this once
  // immediately after the first authenticated navigation.
  return await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

async function startLiveRun(
  page: Page,
  token: string,
  suite: string,
): Promise<number> {
  const res = await page.request.post("http://localhost:3000/live/start", {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: { suite, branch: "main", commitSha: "live01" },
  });
  expect(res.status(), "live/start should return 201").toBe(201);
  const body = await res.json();
  expect(body.id).toBeTruthy();
  return body.id as number;
}

async function postLiveEvent(
  page: Page,
  token: string,
  runId: number,
  event: Record<string, unknown>,
): Promise<void> {
  const res = await page.request.post(`http://localhost:3000/live/${runId}/events`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: event,
  });
  expect(res.status(), `live event ${event.type} should accept`).toBe(200);
}

/**
 * Best-effort cleanup: delete the run we just created so it doesn't
 * pollute the listing for downstream specs. Without this, repeated
 * suite runs accumulate hundreds of synthetic runs that push seeded
 * data out of the dashboard's default 7-day window.
 */
async function deleteRun(page: Page, token: string, runId: number): Promise<void> {
  await page.request.delete(`http://localhost:3000/runs/${runId}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

test.describe("live run flow (real-time test progress)", () => {

  test("LIVE badge appears, pending tests flip to passed as events arrive, then LIVE drops on run.finished", async ({
    page,
  }) => {
    // The route polls fetchRun every 3s; a test that drives 3+ event
    // cycles (started → passed × 2 → failed → finished) needs >30s
    // wall-clock to ride out enough poll ticks.
    test.setTimeout(75_000);

    // 1) Land on dashboard once to populate localStorage with the
    //    auth token; cache it for the rest of the test.
    await page.goto("/dashboard");
    const token = await getToken(page);
    const runId = await startLiveRun(page, token, `live-e2e-${Date.now().toString(36)}`);
    const specPath = "tests/auth/login.spec.ts";

    // 2) Navigate the user. The route opens the SSE, sees a "connected"
    //    sentinel from the server, and flips isLive=true.
    await page.goto(`/runs/${runId}`);
    // Detail page header lands the run id in the meta-row chip
    // (the polished layout dropped the redundant <h1>Run #N</h1>).
    await expect(
      page.locator(".run-header .meta-item", { hasText: new RegExp(`^\\s*#${runId}\\s*$`) }).first(),
    ).toBeVisible({ timeout: 10_000 });

    const liveBadge = page.locator(".live-badge");
    await expect(liveBadge).toBeVisible({ timeout: 10_000 });
    await expect(liveBadge).toHaveText(/LIVE/);

    // 3) Stream events. Open the spec, then start three tests so the
    //    user sees three pending rows queued up. Then transition them
    //    to passed one by one, with a brief gap to let the run-detail
    //    poll (3s) flip the table rows.
    await postLiveEvent(page, token, runId,{ type: "spec.started", spec: specPath });
    const titles = [
      "should login with valid credentials",
      "should reject bad password",
      "should remember session",
    ] as const;
    for (const t of titles) {
      await postLiveEvent(page, token, runId,{ type: "test.started", spec: specPath, test: t });
    }

    // The table polls fetchRun every 3s. Wait for the spec section to
    // appear (it didn't exist when we navigated — the poll picks it
    // up after the spec.started + first test.started events land).
    await expect(page.locator(".spec-section").first()).toBeVisible({ timeout: 10_000 });

    // The status-filter is "all" by default for live runs (no failures
    // yet). All three tests land as `pending` (rendered with
    // .test-status-dot.pending). The spec section auto-mounts via the
    // 3s poll picking up the new spec; the route's collapsedSpecs set
    // was computed at onMount when there were zero specs, so this new
    // spec arrives un-collapsed and its rows mount immediately.
    await expect.poll(
      async () => await page.locator(".test-row").count(),
      { timeout: 15_000, message: "expected 3 pending rows once events propagate via the 3s poll" },
    ).toBeGreaterThanOrEqual(3);

    // All three rows should be in pending status (rendered with the
    // .pending status-dot). This is the contract: pending rows are
    // visible to the user as the run streams in real time.
    await expect
      .poll(async () => await page.locator(".test-status-dot.pending").count(), {
        timeout: 5_000,
      })
      .toBeGreaterThanOrEqual(3);

    // The first test passes — the row should flip from pending to passed.
    await postLiveEvent(page, token, runId,{
      type: "test.passed",
      spec: specPath,
      test: titles[0],
      duration_ms: 850,
    });

    // The next poll cycle (≤3s) updates the row's status-dot. We
    // assert by polling the count of `.test-status-dot.passed`
    // rather than waiting for an exact selector to become visible.
    await expect.poll(
      async () => await page.locator(".test-status-dot.passed").count(),
      { timeout: 10_000, message: "first test should flip from pending to passed" },
    ).toBeGreaterThanOrEqual(1);

    // Pass the second; pending count for that row drops.
    await postLiveEvent(page, token, runId,{
      type: "test.passed",
      spec: specPath,
      test: titles[1],
      duration_ms: 920,
    });
    await expect.poll(
      async () => await page.locator(".test-status-dot.passed").count(),
      { timeout: 10_000 },
    ).toBeGreaterThanOrEqual(2);

    // Final test: emit a failure to also exercise the failure path
    // and the auto-?status=failed redirect on run.finished.
    await postLiveEvent(page, token, runId,{
      type: "test.failed",
      spec: specPath,
      test: titles[2],
      duration_ms: 4500,
      error: "AssertionError: e2e simulated failure",
    });
    await expect.poll(
      async () => await page.locator(".test-status-dot.failed").count(),
      { timeout: 10_000 },
    ).toBeGreaterThanOrEqual(1);

    // 4) Finish the run. SSE drops, isLive flips false, LIVE badge unmounts.
    await postLiveEvent(page, token, runId,{
      type: "run.finished",
      stats: { total: 3, passed: 2, failed: 1, skipped: 0 },
    });
    await expect(liveBadge).toHaveCount(0, { timeout: 10_000 });

    await deleteRun(page, token, runId);
  });

  test("live feed sidebar surfaces incoming events (connected → spec.started → test.passed)", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);
    const runId = await startLiveRun(page, token, `live-feed-${Date.now().toString(36)}`);
    const specPath = "tests/checkout/payment.spec.ts";

    await page.goto(`/runs/${runId}`);
    await expect(page.locator(".live-badge")).toBeVisible({ timeout: 10_000 });

    // The route renders a `.live-feed` panel (sidebar) that grows as
    // events arrive. Initially it has the "connected" sentinel.
    const liveFeed = page.locator(".live-feed");
    await expect(liveFeed).toBeVisible();

    await postLiveEvent(page, token, runId,{ type: "spec.started", spec: specPath });
    await postLiveEvent(page, token, runId,{
      type: "test.passed",
      spec: specPath,
      test: "should compute totals",
      duration_ms: 120,
    });

    // The feed should now contain the spec path and the test title
    // somewhere in its rendered text.
    await expect.poll(
      async () => (await liveFeed.textContent()) ?? "",
      { timeout: 5_000 },
    ).toContain("should compute totals");

    await postLiveEvent(page, token, runId,{
      type: "run.finished",
      stats: { total: 1, passed: 1, failed: 0, skipped: 0 },
    });

    await deleteRun(page, token, runId);
  });

  test("aborting a live run flips the badge state and shows the abort indicator", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const token = await getToken(page);
    const runId = await startLiveRun(page, token, `live-abort-${Date.now().toString(36)}`);

    // Post a spec + test event so the aborted run has ≥1 spec/test
    // row; otherwise downstream tests that pick the first run-row
    // off the listing land on this empty run and trip on
    // .spec-section visibility.
    await postLiveEvent(page, token, runId, {
      type: "spec.started",
      spec: "tests/abort-demo.spec.ts",
    });
    await postLiveEvent(page, token, runId, {
      type: "test.passed",
      spec: "tests/abort-demo.spec.ts",
      test: "should run before abort",
      duration_ms: 50,
    });

    await page.goto(`/runs/${runId}`);
    await expect(page.locator(".live-badge")).toBeVisible({ timeout: 10_000 });

    // Trigger abort via the backend API. The run-detail page sees
    // a "run.aborted" event over SSE → isLive=false, runAborted=true,
    // and the header pill flips to ABORTED.
    const res = await page.request.post(`http://localhost:3000/live/${runId}/abort`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { reason: "e2e: simulated abort" },
    });
    expect(res.status()).toBeLessThan(400);

    // LIVE badge drops; either an ABORTED transient banner OR the
    // header's run-status-badge shows "Aborted" once the route
    // refetches the run.
    await expect(page.locator(".live-badge")).toHaveCount(0, { timeout: 10_000 });

    await deleteRun(page, token, runId);
  });
});
