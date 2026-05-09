import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "./fixtures/users";

/**
 * Live-reporter adapter coverage — one test per ecosystem reporter,
 * each simulating the EXACT event sequence that adapter emits.
 *
 * The three adapters (in `packages/flakey-live-reporter/src`) are:
 *
 *   - **mocha.ts** (Cypress/Mocha): `run.started` → per-spec
 *     {`spec.started`, then per-test `test.started` + `test.passed/failed`
 *     coming from the Cypress reporter, then `spec.finished` with
 *     stats} → `run.finished`.
 *   - **playwright.ts**: `run.started` (with total stats) → per-test
 *     `test.started` + `test.passed/failed/skipped` (no spec.started/
 *     spec.finished — Playwright doesn't have a `before:spec` hook) →
 *     `run.finished`.
 *   - **webdriverio.ts**: `run.started` → per-spec `spec.started`
 *     → per-test `test.passed/failed/skipped` (no `test.started` — WDIO
 *     doesn't have an onTestStart hook) → `run.finished`.
 *
 * Each test drives the canonical sequence for its adapter and asserts
 * the run-detail page reflects the expected state. A regression in
 * the live route's event handling for a specific adapter (e.g. WDIO
 * fast-path that skips test.started) would surface here.
 */

async function getToken(page: Page): Promise<string> {
  return await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

async function startLiveRun(page: Page, token: string, suite: string): Promise<number> {
  const res = await page.request.post("http://localhost:3000/live/start", {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: { suite, branch: "main", commitSha: "live-adapter" },
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
  expect(res.status(), `event ${event.type} should be accepted`).toBe(200);
}

/**
 * Best-effort cleanup so synthetic adapter runs don't pollute the
 * /runs listing for downstream specs. Repeated suite runs would
 * otherwise accumulate hundreds of synthetic runs and push seeded
 * data out of the dashboard's default 7-day window.
 */
async function deleteRun(page: Page, token: string, runId: number): Promise<void> {
  await page.request.delete(`http://localhost:3000/runs/${runId}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

async function bootstrap(
  page: Page,
  suiteSlug: string,
): Promise<{ token: string; runId: number }> {
  await page.goto("/dashboard");
  const token = await getToken(page);
  const runId = await startLiveRun(page, token, `${suiteSlug}-${Date.now().toString(36)}`);
  await page.goto(`/runs/${runId}`);
  await expect(
    page.getByRole("heading", { name: new RegExp(`^Run #${runId}\\s*$`) }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".live-badge")).toBeVisible({ timeout: 10_000 });
  return { token, runId };
}

test.describe("live-reporter adapter — Cypress/Mocha event sequence", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("emits spec.started → test.started → test.passed/failed → spec.finished → run.finished", async ({
    page,
  }) => {
    test.setTimeout(75_000);
    const { token, runId } = await bootstrap(page, "live-cypress-mocha");

    // Cypress example uses paths like `cypress/e2e/auth/login.cy.ts`.
    const specPath = "cypress/e2e/auth/login.cy.ts";

    // Cypress's mocha.ts emits run.started immediately after /live/start,
    // then before:spec → spec.started.
    await postEvent(page, token, runId, { type: "run.started" });
    await postEvent(page, token, runId, { type: "spec.started", spec: specPath });

    // Per-test events come from the Cypress reporter (reporter.ts:onTestStart):
    // each test gets a test.started with the FULL TITLE format
    // ("describe > it"). The seeded mochawesome run also has a
    // "should login with valid credentials" title — using the same
    // title here is fine because error-modal-tabs.spec.ts looks up
    // by data shape (needsCode: true), not just title fragment.
    const fullTitle = "Auth flow > should login with valid credentials";
    await postEvent(page, token, runId, {
      type: "test.started",
      test: fullTitle,
      spec: specPath,
    });
    await expect.poll(async () => await page.locator(".test-status-dot.pending").count(), {
      timeout: 15_000,
    }).toBeGreaterThanOrEqual(1);

    // Test passes — reporter.ts emits test.passed with full_title + spec
    // + duration.
    await postEvent(page, token, runId, {
      type: "test.passed",
      test: fullTitle,
      spec: specPath,
      status: "passed",
      duration_ms: 1234,
    });
    await expect.poll(async () => await page.locator(".test-status-dot.passed").count(), {
      timeout: 10_000,
    }).toBeGreaterThanOrEqual(1);

    // mocha.ts emits spec.finished with per-spec stats from
    // results.stats. The route uses these to update the live-feed.
    await postEvent(page, token, runId, {
      type: "spec.finished",
      spec: specPath,
      stats: { total: 1, passed: 1, failed: 0, skipped: 0 },
    });

    await postEvent(page, token, runId, { type: "run.finished" });
    await expect(page.locator(".live-badge")).toHaveCount(0, { timeout: 10_000 });

    await deleteRun(page, token, runId);
  });
});

test.describe("live-reporter adapter — Playwright event sequence", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("emits run.started (with stats) → test.started/test.passed → run.finished (no spec events)", async ({
    page,
  }) => {
    test.setTimeout(75_000);
    const { token, runId } = await bootstrap(page, "live-playwright");

    // Playwright example uses paths like `tests/auth/login.spec.ts`,
    // resolved via `test.parent.location.file` → an absolute path; the
    // adapter forwards whatever Playwright provides.
    const specPath = "tests/checkout/payment.spec.ts";

    // playwright.ts:onBegin emits run.started with the total test
    // count up front (unlike Cypress which has no stats on
    // run.started).
    await postEvent(page, token, runId, {
      type: "run.started",
      stats: { total: 2, passed: 0, failed: 0, skipped: 0 },
    });

    // Playwright does NOT emit spec.started — so the spec section
    // mounts lazily on first test event (upsertPendingTest's
    // findOrCreateSpec inserts the row).
    const tests = ["should complete checkout", "should reject expired card"];
    for (const t of tests) {
      await postEvent(page, token, runId, { type: "test.started", test: t, spec: specPath });
    }

    // Both pending rows show as the run streams in.
    await expect.poll(async () => await page.locator(".test-row").count(), {
      timeout: 15_000,
    }).toBeGreaterThanOrEqual(2);

    // First passes; second fails.
    await postEvent(page, token, runId, {
      type: "test.passed",
      test: tests[0],
      spec: specPath,
      status: "passed",
      duration_ms: 6800,
    });
    await postEvent(page, token, runId, {
      type: "test.failed",
      test: tests[1],
      spec: specPath,
      status: "failed",
      duration_ms: 8500,
      error: "AssertionError: expected expired card to surface error banner",
    });

    await expect.poll(async () => await page.locator(".test-status-dot.passed").count(), {
      timeout: 10_000,
    }).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => await page.locator(".test-status-dot.failed").count(), {
      timeout: 10_000,
    }).toBeGreaterThanOrEqual(1);

    await postEvent(page, token, runId, { type: "run.finished" });
    await expect(page.locator(".live-badge")).toHaveCount(0, { timeout: 10_000 });

    await deleteRun(page, token, runId);
  });
});

test.describe("live-reporter adapter — WebdriverIO event sequence", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("emits spec.started → test.passed/failed (no test.started) → run.finished", async ({
    page,
  }) => {
    test.setTimeout(75_000);
    const { token, runId } = await bootstrap(page, "live-wdio");

    // WebdriverIO example uses paths like `test/specs/login.spec.js`.
    const specPath = "test/specs/login.spec.js";

    await postEvent(page, token, runId, { type: "run.started" });
    await postEvent(page, token, runId, { type: "spec.started", spec: specPath });

    // WDIO's adapter has NO onTestStart hook — only onTestPass /
    // onTestFail / onTestSkip. So pending rows never surface for
    // WDIO runs; results land directly as terminal states.
    await postEvent(page, token, runId, {
      type: "test.passed",
      test: "should sign in",
      spec: specPath,
      status: "passed",
      duration_ms: 980,
    });
    await postEvent(page, token, runId, {
      type: "test.failed",
      test: "should reject empty password",
      spec: specPath,
      status: "failed",
      duration_ms: 540,
      error: "AssertionError: empty password silently accepted",
    });
    await postEvent(page, token, runId, {
      type: "test.skipped",
      test: "should remember me checkbox",
      spec: specPath,
      status: "skipped",
    });

    // After events propagate through the 3s poll, the rows surface
    // with their respective terminal-state dots — no pending dots.
    await expect.poll(async () => await page.locator(".test-row").count(), {
      timeout: 15_000,
    }).toBeGreaterThanOrEqual(3);
    await expect.poll(async () => await page.locator(".test-status-dot.passed").count(), {
      timeout: 5_000,
    }).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => await page.locator(".test-status-dot.failed").count(), {
      timeout: 5_000,
    }).toBeGreaterThanOrEqual(1);

    await postEvent(page, token, runId, { type: "run.finished" });
    await expect(page.locator(".live-badge")).toHaveCount(0, { timeout: 10_000 });

    await deleteRun(page, token, runId);
  });
});

test.describe("live-reporter adapter — Cucumber/Gherkin spec format", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("Cucumber-style .feature files surface in the live spec list", async ({ page }) => {
    test.setTimeout(75_000);
    const { token, runId } = await bootstrap(page, "live-cucumber");

    // Cypress-cucumber example resolves spec paths to .feature files
    // (e.g. `cypress/e2e/login.feature`). Each scenario surfaces as
    // a test under that spec.
    const specPath = "cypress/e2e/login.feature";

    await postEvent(page, token, runId, { type: "run.started" });
    await postEvent(page, token, runId, { type: "spec.started", spec: specPath });

    // A scenario with full_title "Login flow > User logs in with
    // valid creds".
    const scenario = "Login flow > User logs in with valid creds";
    await postEvent(page, token, runId, {
      type: "test.started",
      test: scenario,
      spec: specPath,
    });
    await postEvent(page, token, runId, {
      type: "test.passed",
      test: scenario,
      spec: specPath,
      status: "passed",
      duration_ms: 4200,
    });

    // Spec section in the table reflects the .feature file path.
    await expect.poll(
      async () => await page.locator(".spec-section").filter({ hasText: ".feature" }).count(),
      { timeout: 15_000 },
    ).toBeGreaterThanOrEqual(1);

    await postEvent(page, token, runId, {
      type: "spec.finished",
      spec: specPath,
      stats: { total: 1, passed: 1, failed: 0, skipped: 0 },
    });
    await postEvent(page, token, runId, { type: "run.finished" });
    await expect(page.locator(".live-badge")).toHaveCount(0, { timeout: 10_000 });

    await deleteRun(page, token, runId);
  });
});

test.describe("live-reporter — heartbeat / empty-events flush", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("empty-event POST keeps stale-run detection happy without changing state", async ({
    page,
  }) => {
    const { token, runId } = await bootstrap(page, "live-heartbeat");

    // The LiveClient's 30s heartbeat POSTs an empty array body —
    // the backend treats this as activity (touches lastEventAt) but
    // emits nothing. Mirror that in the test: an empty body must
    // be accepted by the events endpoint without changing run state.
    const res = await page.request.post(`http://localhost:3000/live/${runId}/events`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: [],
    });
    expect(res.status()).toBe(200);

    // Run still LIVE; no test rows because no events arrived.
    await expect(page.locator(".live-badge")).toBeVisible();
    expect(await page.locator(".test-row").count()).toBe(0);

    // Clean up — terminate the live run so it doesn't pollute the
    // listing for downstream tests.
    await postEvent(page, token, runId, { type: "run.finished" });
    await expect(page.locator(".live-badge")).toHaveCount(0, { timeout: 10_000 });

    await deleteRun(page, token, runId);
  });
});
