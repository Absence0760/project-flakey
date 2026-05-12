import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * The "status / filter tag" controls on the (app)/* pages now use
 * one shared visual pattern — `.filter-tab` inside `.filter-tabs`.
 *
 * Before this consolidation, `/` had a bespoke `.summary-btn` row
 * (inline text + bullet separators + status-colored text) while
 * every other page (`/flaky`, `/errors`, `/slowest`, `/manual-tests`)
 * used `.filter-tab` (segmented-control look in a gray pill).
 *
 * These specs pin the contract:
 *   1. `.summary-btn` is gone from `/`.
 *   2. Every page that exposes a filter row uses `.filter-tab`
 *      inside `.filter-tabs`.
 *   3. The rendered `.filter-tab` height is consistent (±2 px) on
 *      `/` vs any other page — regression guard against the kind of
 *      drift the per-page CSS copies invited before.
 */

async function login(page: Page, path: string): Promise<void> {
  await page.goto(path);
  // `.filter-tabs` is the canonical container; wait for it to mount.
  await page.locator(".filter-tabs").first().waitFor({ timeout: 15_000 });
}

async function firstFilterTabHeight(page: Page): Promise<number> {
  return page.locator(".filter-tab").first().evaluate((el) =>
    el.getBoundingClientRect().height,
  );
}

test.describe("filter-tab is the single canonical 'tag' pattern", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("/ no longer uses the legacy .summary-btn / .summary-bar markup", async ({ page }) => {
    await login(page, "/");
    await expect(page.locator(".summary-btn")).toHaveCount(0);
    await expect(page.locator(".summary-bar")).toHaveCount(0);
  });

  test("/ now uses the .filter-tabs / .filter-tab segmented control", async ({ page }) => {
    await login(page, "/");
    const tabs = page.locator(".filter-tabs .filter-tab");
    // At minimum: All + Passed + Failed. New failures shows only
    // when stats.newFailures > 0 (seed-dependent), so >=3.
    const count = await tabs.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test("the status color modifiers (.pass, .fail, .new) tint the count pill, not the tab", async ({ page }) => {
    await login(page, "/");

    // The .filter-tab itself should NOT be color-coded by status —
    // that's what made the old .summary-btn pattern stand out from
    // the other pages. Only the inner .tab-count carries colour.
    const passTab = page.locator(".filter-tab.pass");
    const failTab = page.locator(".filter-tab.fail");
    await expect(passTab).toBeVisible();
    await expect(failTab).toBeVisible();

    // The tab's own colour resolves to a neutral text colour, not
    // the pass-green. Sample by reading getComputedStyle.color: the
    // pass tab and fail tab should have the SAME computed colour
    // when neither is active (both render as var(--text-secondary)).
    const passColor = await passTab.evaluate((el) => getComputedStyle(el).color);
    const failColor = await failTab.evaluate((el) => getComputedStyle(el).color);
    expect(
      passColor,
      `.filter-tab.pass and .filter-tab.fail must share neutral text color (got ${passColor} vs ${failColor})`,
    ).toBe(failColor);

    // But the inner .tab-count badges should differ — that's where
    // the status hue lives now.
    const passBadge = await passTab.locator(".tab-count").evaluate((el) => getComputedStyle(el).color);
    const failBadge = await failTab.locator(".tab-count").evaluate((el) => getComputedStyle(el).color);
    expect(passBadge).not.toBe(failBadge);
  });

  test("filter-tab height is consistent across pages (±2 px)", async ({ page }) => {
    // Measure on /, then on a page that previously used filter-tab
    // already (`/manual-tests`). The two should match within a
    // sub-pixel rounding budget; a large delta would indicate the
    // pages have drifted CSS copies of .filter-tab.
    await login(page, "/");
    const homeH = await firstFilterTabHeight(page);

    await login(page, "/manual-tests");
    const manualH = await firstFilterTabHeight(page);

    expect(
      Math.abs(homeH - manualH),
      `filter-tab heights differ across pages: / = ${homeH.toFixed(1)} px, /manual-tests = ${manualH.toFixed(1)} px`,
    ).toBeLessThanOrEqual(2);
  });
});
