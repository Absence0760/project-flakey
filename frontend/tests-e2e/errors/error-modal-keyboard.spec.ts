import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * ErrorModal — keyboard + close affordances.
 *
 * The modal's escape-to-close, click-on-backdrop-to-close, and
 * close-button (×) flows are user-critical: a regression here
 * leaves a stuck overlay over the route.
 */

async function openModalForFailedTest(page: Page): Promise<void> {
  // Pick a run that has per-test rows (with a failed test), not just
  // a spec-level failure — cucumber-style runs report `failed > 0` on
  // the spec without any underlying `.test-row` entries, which would
  // strand this test on a page with "No tests match the current
  // filter." Query the backend to find a real per-test failure.
  await page.goto("/runs");
  await page.locator("tr.run-row").first().waitFor({ timeout: 15_000 });
  const token = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
  if (!token) throw new Error("no auth token in localStorage");

  const runsRes = await page.request.get("http://localhost:3000/runs?limit=200", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { runs } = (await runsRes.json()) as { runs: { id: number; failed: number }[] };
  const candidates = runs.filter((r) => r.failed > 0).map((r) => r.id);

  for (const id of candidates) {
    const detailRes = await page.request.get(`http://localhost:3000/runs/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const detail = (await detailRes.json()) as {
      specs?: { tests?: { status: string }[] }[];
    };
    const hasFailedTestRow = (detail.specs ?? []).some((s) =>
      (s.tests ?? []).some((t) => t.status === "failed"),
    );
    if (hasFailedTestRow) {
      await page.goto(`/runs/${id}?status=failed`);
      await expect(page.locator(".test-row").first()).toBeVisible({ timeout: 10_000 });
      await page.locator("button.test-name").first().click();
      await expect(page.locator(".debugger")).toBeVisible({ timeout: 5_000 });
      return;
    }
  }
  throw new Error("No run with a failed per-test row found in the first 200 runs");
}

test.describe("ErrorModal — close affordances", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("Escape key closes the modal", async ({ page }) => {
    await openModalForFailedTest(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".debugger")).toHaveCount(0, { timeout: 2_000 });
  });

  test("close-button (×) closes the modal", async ({ page }) => {
    await openModalForFailedTest(page);
    await page.locator(".debugger .close-btn").click();
    await expect(page.locator(".debugger")).toHaveCount(0, { timeout: 2_000 });
  });

  test("clicking the backdrop closes the modal", async ({ page }) => {
    await openModalForFailedTest(page);
    // The .backdrop is a sibling/ancestor of .debugger that closes
    // on click.
    await page.locator(".backdrop").click({ position: { x: 5, y: 5 } });
    await expect(page.locator(".debugger")).toHaveCount(0, { timeout: 2_000 });
  });
});
