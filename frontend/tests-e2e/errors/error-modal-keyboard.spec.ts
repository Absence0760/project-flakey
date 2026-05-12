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
  // Use ?status=failed on the runs list so we land on a failed-run
  // card. The first such card guaranteed has ≥1 failed test.
  await page.goto("/?status=failed");
  const firstCard = page.locator("a.run-card").first();
  await expect(firstCard).toBeVisible({ timeout: 10_000 });
  const href = await firstCard.getAttribute("href");
  await page.goto(`${href}?status=failed`);
  // The route auto-expands failed specs.
  await expect(page.locator(".test-row").first()).toBeVisible({ timeout: 10_000 });

  await page.locator("button.test-name").first().click();
  await expect(page.locator(".debugger")).toBeVisible({ timeout: 5_000 });
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
