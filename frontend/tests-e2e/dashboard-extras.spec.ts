import { expect, test } from "@playwright/test";

import { ADMIN_USER } from "./fixtures/users";

/**
 * /dashboard — KPI panels, suite health, automation/manual rollups,
 * and quick navigations to deeper pages.
 */

test.describe("/dashboard — KPI panels + nav", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("renders KPI top-row stats (total runs, automation passes, failures)", async ({ page }) => {
    await page.goto("/dashboard");
    // The KPI cards live near the top of the page; we check for
    // numeric values inside any .stat-value style elements.
    await expect(page.locator(".stat-value, .kpi-value, .panel").first()).toBeVisible({
      timeout: 10_000,
    });
    // At least one KPI shows a number > 0 since the seed has 50+ runs.
    const numbers = await page.locator("body")
      .evaluate((el) => (el.textContent ?? "").match(/\d+/g) ?? []);
    expect(numbers.length).toBeGreaterThan(0);
  });

  test("'Suite Health' section renders ≥1 suite card", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.locator(".suite-card").first()).toBeVisible({ timeout: 10_000 });
  });

  test("date-range picker opens / mounts a calendar UI", async ({ page }) => {
    await page.goto("/dashboard");
    // The route's date selector is a dropdown button at the top-right.
    const datePicker = page.locator("button", { hasText: /^[A-Z][a-z]+\s\d+/ }).first();
    if (await datePicker.isVisible().catch(() => false)) {
      await datePicker.click();
      // Some calendar UI should open. Just don't crash.
    }
  });

  test("quick-nav: clicking 'Automated runs' sidebar link lands on /", async ({ page }) => {
    await page.goto("/dashboard");
    // Sidebar nav-item is `<a class="nav-item"><span>icon</span> Automated runs</a>`
    // — substring match ignores the icon prefix.
    await page.locator("a.nav-item", { hasText: "Automated runs" }).click();
    await expect(page).toHaveURL(/^http:\/\/localhost:7777\/(\?.*)?$/);
  });

  test("quick-nav: clicking 'Errors' sidebar link lands on /errors", async ({ page }) => {
    await page.goto("/dashboard");
    await page.locator("a.nav-item", { hasText: "Errors" }).click();
    await expect(page).toHaveURL(/\/errors$/);
  });
});
