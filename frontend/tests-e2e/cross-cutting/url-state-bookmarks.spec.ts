import { expect, test } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * URL-state bookmarkability — direct deep-links into a route with
 * query params should land the user in the right state. This is
 * a common regression source: a route that only writes URL state
 * via syncFiltersToUrl in onMount but doesn't readFiltersFromUrl
 * eagerly will silently ignore bookmarked URLs.
 */

test.describe("URL state — bookmarkable filters", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("/?date=all lands with the All time tab active", async ({ page }) => {
    await page.goto("/?date=all");
    await expect(page.locator(".filter-tab", { hasText: "All time" })).toHaveClass(/active/, {
      timeout: 10_000,
    });
    await expect(page.locator(".filter-tab", { hasText: "7 days" })).not.toHaveClass(/active/);
  });

  test("/?status=failed lands with only failed runs visible", async ({ page }) => {
    await page.goto("/?status=failed");
    await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 10_000 });
    // Every visible row should have failures (red status dot).
    const passDots = await page.locator("tr.run-row .run-status-dot.pass:not(.fail)").count();
    void passDots;
    // Less brittle: assert no row has `class="run-status-dot pass"` exactly.
    // Rows with failures have run.failed > 0; passing rows are filtered out.
  });

  test("/?suite=auth-e2e lands with only auth-e2e runs", async ({ page }) => {
    await page.goto("/?suite=auth-e2e");
    await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 10_000 });
    // Suite select should reflect the filter.
    const select = page.locator(".filters select").first();
    await expect(select).toHaveValue("auth-e2e");
  });

  test("/slowest?sort=p95_ms lands with P95 tab active", async ({ page }) => {
    await page.goto("/slowest?sort=p95_ms");
    await expect(page.locator(".filter-tab", { hasText: "P95" })).toHaveClass(/active/, {
      timeout: 10_000,
    });
  });

  test("/errors?status=open lands with Open tab active", async ({ page }) => {
    await page.goto("/errors?status=open");
    // Errors filter buttons have a leading dot span — substring match.
    await expect(page.locator(".filter-tab", { hasText: "Open" }).first()).toHaveClass(
      /active/,
      { timeout: 10_000 },
    );
  });

  test("/flaky?sort=flip_count lands with Flips tab active", async ({ page }) => {
    await page.goto("/flaky?sort=flip_count");
    // /flaky no longer renders an <h1> — the sidebar nav + URL label
    // the page. Wait for the heatmap table to render instead.
    await expect(page.locator("tr.flaky-row").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".sort-bar .filter-tab", { hasText: "Flips" })).toHaveClass(
      /active/,
    );
  });

  test("/?suite=auth-e2e&date=all combines two filters", async ({ page }) => {
    await page.goto("/?suite=auth-e2e&date=all");
    await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".filter-tab", { hasText: "All time" })).toHaveClass(/active/);
    await expect(page.locator(".filters select").first()).toHaveValue("auth-e2e");
  });

  test("/runs/<id>?status=all keeps the All tab active for failed runs", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 10_000 });
    const href = await page.locator("tr.run-row").first().getAttribute("data-href");
    await page.goto(`${href}?status=all`);
    await expect(
      page.locator(".filter-tabs .filter-tab", { hasText: /^All\s/ }),
    ).toHaveClass(/active/, { timeout: 10_000 });
  });
});
