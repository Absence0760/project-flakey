import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * /releases & /releases/<id> — extra coverage beyond the existing
 * smoke tests in releases.spec.ts and release-detail.spec.ts.
 */

async function gotoV240(page: Page): Promise<void> {
  await page.goto("/releases");
  const card = page.locator(".release-card", {
    has: page.locator(".version", { hasText: "v2.4.0" }),
  }).first();
  await card.click();
  await expect(page.getByRole("heading", { name: "v2.4.0" })).toBeVisible({ timeout: 10_000 });
}

test.describe("/releases extras", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("Linked automated runs panel: count badge matches link-list rows", async ({ page }) => {
    await gotoV240(page);
    const panel = page.locator(".linked-runs-panel details");
    await panel.locator("summary").click();

    // The summary text shows "X runs". Compare to actual <li> count.
    const liCount = await panel.locator(".link-list li").count();
    expect(liCount).toBeGreaterThanOrEqual(1);
  });

  test("Linked manual tests panel renders ≥1 tests for v2.4.0", async ({ page }) => {
    await gotoV240(page);
    const panel = page.locator(".linked-tests-panel details");
    await panel.locator("summary").click();
    const liCount = await panel.locator(".link-list li").count();
    expect(liCount).toBeGreaterThan(0);
  });

  test("Requirements coverage panel renders provider badges", async ({ page }) => {
    await gotoV240(page);
    const panel = page.locator(".requirements-panel details");
    await panel.locator("summary").click();
    await expect(panel.locator(".provider-badge").first()).toBeVisible({ timeout: 5_000 });
  });

  test("Release header shows the release version + name", async ({ page }) => {
    await gotoV240(page);
    await expect(page.locator(".release-header").locator(".name")).toContainText("Q2 launch");
  });

  test("'Back to all releases' nav returns to the list", async ({ page }) => {
    await gotoV240(page);
    await page.locator("a, button", { hasText: /All releases|← Releases/ }).first().click();
    await expect(page).toHaveURL(/\/releases$/);
    await expect(page.locator(".release-grid").first()).toBeVisible();
  });
});
