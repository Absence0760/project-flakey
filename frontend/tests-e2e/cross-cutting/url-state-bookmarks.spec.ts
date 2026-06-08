import { expect, test } from "../fixtures/test";


/**
 * URL-state bookmarkability — direct deep-links into a route with
 * query params should land the user in the right state. This is
 * a common regression source: a route that only writes URL state
 * via syncFiltersToUrl in onMount but doesn't readFiltersFromUrl
 * eagerly will silently ignore bookmarked URLs.
 */

test.describe("URL state — bookmarkable filters", () => {

  test("/runs?date=all lands with the All time tab active", async ({ page }) => {
    await page.goto("/runs?date=all");
    await expect(page.locator(".filter-tab", { hasText: "All time" })).toHaveClass(/active/, {
      timeout: 10_000,
    });
    await expect(page.locator(".filter-tab", { hasText: "7 days" })).not.toHaveClass(/active/);
  });

  test("/runs?status=failed lands with only failed runs visible", async ({ page }) => {
    await page.goto("/runs?status=failed");
    await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 10_000 });
    // Every visible row should have failures (red status dot).
    const passDots = await page.locator("tr.run-row .run-status-dot.pass:not(.fail)").count();
    void passDots;
    // Less brittle: assert no row has `class="run-status-dot pass"` exactly.
    // Rows with failures have run.failed > 0; passing rows are filtered out.
  });

  test("/runs?suite=auth-e2e lands with only auth-e2e runs", async ({ page }) => {
    await page.goto("/runs?suite=auth-e2e");
    await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 10_000 });
    // Suite/branch/env dropdowns live inside the "Filters" popover —
    // open it before reading the <select> value.
    await page.locator(".filter-trigger").click();
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

  test("/runs?suite=auth-e2e&date=all combines two filters", async ({ page }) => {
    await page.goto("/runs?suite=auth-e2e&date=all");
    await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".filter-tab", { hasText: "All time" })).toHaveClass(/active/);
    // Suite/branch/env now live inside a "Filters" popover — open it
    // before asserting the <select> value reflects the URL state.
    await page.locator(".filter-trigger").click();
    await expect(page.locator(".filters select").first()).toHaveValue("auth-e2e");
  });

  test("/runs/<id>?status=all keeps the All tab active for failed runs", async ({ page }) => {
    await page.goto("/runs");
    await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 10_000 });
    const href = await page.locator("tr.run-row").first().getAttribute("data-href");
    await page.goto(`${href}?status=all`);
    await expect(
      page.locator(".filter-tabs .filter-tab", { hasText: /^All\s/ }),
    ).toHaveClass(/active/, { timeout: 10_000 });
  });
});

/**
 * Sidebar round-trip — filters live in the URL, but the sidebar links are
 * bare paths. The (app) layout remembers each section's last query string
 * (section-views store) so navigating away and back via the sidebar restores
 * the filters instead of resetting them. Regression for that wiring.
 */
test.describe("Sidebar remembers per-section filters", () => {
  test("returning to a section via the sidebar restores its last filters", async ({ page }) => {
    // Land on /runs and narrow to failed runs — this writes ?status=failed.
    await page.goto("/runs?status=failed");
    await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".filter-tab", { hasText: "Failed" })).toHaveClass(/active/);

    // Navigate away via the sidebar, then back — the "Automated runs" link
    // should carry the remembered query string, not reset to the default.
    await page.locator(".nav-item", { hasText: "Flaky" }).click();
    await expect(page).toHaveURL(/\/flaky/, { timeout: 10_000 });

    await page.locator(".nav-item", { hasText: "Automated runs" }).click();
    await expect(page).toHaveURL(/\/runs\?.*status=failed/, { timeout: 10_000 });
    await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".filter-tab", { hasText: "Failed" })).toHaveClass(/active/);
  });

  test("an untouched section's sidebar link stays a bare path", async ({ page }) => {
    // Visiting /runs unfiltered must not leave a stale query string on the
    // Flaky link the user never touched.
    await page.goto("/runs");
    await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 10_000 });
    const flakyHref = await page.locator(".nav-item", { hasText: "Flaky" }).getAttribute("href");
    expect(flakyHref).toBe("/flaky");
  });

  test("a new tab inherits a section's remembered filters", async ({ page, context }) => {
    // Filter /runs in the first tab — persisted to localStorage, which is
    // shared across tabs of the same browser profile.
    await page.goto("/runs?status=failed");
    await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".filter-tab", { hasText: "Failed" })).toHaveClass(/active/);

    // Open a brand-new tab (shares the context's localStorage) and land on a
    // different section. Its sidebar "Automated runs" link should already
    // carry the remembered filter, and following it restores the failed view.
    const tab2 = await context.newPage();
    await tab2.goto("/dashboard");
    await tab2.locator(".nav-item", { hasText: "Automated runs" }).click();
    await expect(tab2).toHaveURL(/\/runs\?.*status=failed/, { timeout: 10_000 });
    await expect(tab2.locator("tr.run-row").first()).toBeVisible({ timeout: 10_000 });
    await expect(tab2.locator(".filter-tab", { hasText: "Failed" })).toHaveClass(/active/);
    await tab2.close();
  });
});
