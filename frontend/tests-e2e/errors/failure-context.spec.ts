import { expect, test } from "../fixtures/test";

/**
 * ErrorModal — Cypress failure-context (Phase 13) rendering in the Details tab.
 *
 * The reporter (@flakeytesting/cypress-reporter) captures browser console,
 * network failures, uncaught errors, and the retry trail onto
 * tests.failure_context. It was stored + typed end-to-end but rendered
 * nowhere; this spec pins the Details-tab rendering added to ErrorModal.
 *
 * The seed attaches a deterministic failure_context to the same
 * "e2e-cucumber" gherkin demo run the snapshot-viewer spec uses.
 */

async function openGherkinRun(page: import("@playwright/test").Page): Promise<number> {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });

  const runId = await page.evaluate(async () => {
    const token = localStorage.getItem("bt_token");
    const res = await fetch("http://localhost:3000/runs?limit=200", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    const run = body.runs.find((r: { suite_name: string }) => r.suite_name === "e2e-cucumber");
    return run?.id ?? null;
  });
  expect(runId, "seed should have created the e2e-cucumber gherkin demo run").toBeTruthy();

  await page.goto(`/runs/${runId}`);
  await expect(
    page.locator(".run-header .meta-item", { hasText: new RegExp(`^\\s*#${runId}\\s*$`) }).first(),
  ).toBeVisible({ timeout: 10_000 });
  return runId as number;
}

async function openModalToDetails(page: import("@playwright/test").Page): Promise<void> {
  const testButton = page.locator(".test-list").getByRole("button", {
    name: "Login with valid credentials (Gherkin demo)",
  });
  await expect(testButton).toBeVisible({ timeout: 5_000 });
  await testButton.click();
  await expect(page.locator(".debugger")).toBeVisible({ timeout: 5_000 });

  // The Details tab is only present when there's metadata OR failure-context.
  // The gherkin demo test has no Playwright metadata, so its presence here
  // proves the hasFailureContext gate works.
  const detailsTab = page.locator(".pane-tab", { hasText: /^Details$/ });
  await expect(detailsTab).toBeVisible({ timeout: 5_000 });
  await detailsTab.click();
  await expect(page.locator(".details-panel")).toBeVisible({ timeout: 5_000 });
}

test.describe("ErrorModal failure-context (gherkin demo run)", () => {
  test("Details tab surfaces console, network, uncaught, and retry sections", async ({ page }) => {
    await openGherkinRun(page);
    await openModalToDetails(page);

    const panel = page.locator(".details-panel");

    // Each failure_context field renders under its own heading.
    await expect(panel.getByText("Browser Console", { exact: true })).toBeVisible();
    await expect(panel.getByText("Network Failures", { exact: true })).toBeVisible();
    await expect(panel.getByText("Uncaught Errors", { exact: true })).toBeVisible();
    await expect(panel.getByText("Retry Errors", { exact: true })).toBeVisible();
  });

  test("renders the captured console/network/error content", async ({ page }) => {
    await openGherkinRun(page);
    await openModalToDetails(page);

    const panel = page.locator(".details-panel");

    // Console buffer (level-prefixed lines) is shown verbatim.
    await expect(panel).toContainText("POST /api/login 401 (Unauthorized)");
    // Network failures render as their own list rows.
    await expect(panel.locator(".diag-net").filter({ hasText: "POST /api/login → 401" })).toBeVisible();
    // Uncaught error stack is shown.
    await expect(panel).toContainText("Cannot read properties of null");
    // Retry trail renders attempts 1-based.
    await expect(panel).toContainText("Attempt 1");
    await expect(panel).toContainText("Attempt 2");
  });

  test("error-level console lines get the fail-color class", async ({ page }) => {
    await openGherkinRun(page);
    await openModalToDetails(page);

    // The console "error:" line is class console-err; the "warn:" line is
    // console-warn. This pins the per-level styling hook, not the exact color.
    const panel = page.locator(".details-panel");
    await expect(panel.locator(".console-line.console-err")).toHaveCount(1);
    await expect(panel.locator(".console-line.console-warn")).toHaveCount(1);
  });
});
