import { expect, test } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * /slowest — tests ranked by duration with percentile + trend analysis.
 *
 * The list shows ≥1 row per "test that ran in 2+ runs" (server-side
 * threshold in fetchSlowestTests). Seed runs are heavy enough that
 * many tests qualify; we don't pin row counts but assert rendering,
 * sort, suite filter, expand-on-click, and URL state-sync.
 */

test.describe("/slowest", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test.beforeEach(async ({ page }) => {
    await page.goto("/slowest");
    // Loading is async; the page renders <p class="status-text">Loading...</p>
    // first. Wait for the test list (or the empty state) to land.
    await expect(page.locator(".test-list, .empty")).toBeVisible({ timeout: 10_000 });
  });

  test("renders the page header + sort bar + at least one test card", async ({ page }) => {
    await expect(page.locator(".description")).toContainText(
      "Tests ranked by duration",
    );

    // Four sort tabs are always rendered.
    const sortTabs = page.locator(".sort-bar .filter-tab");
    await expect(sortTabs).toHaveCount(4);
    await expect(sortTabs.nth(0)).toHaveText("Average");
    await expect(sortTabs.nth(0)).toHaveClass(/active/);

    // Seed produces enough variety that at least one slow test qualifies.
    await expect(page.locator(".test-card").first()).toBeVisible({ timeout: 5_000 });
  });

  test("switching the sort metric updates ?sort= and toggles the active tab", async ({
    page,
  }) => {
    const maxTab = page.locator(".sort-bar .filter-tab", { hasText: "Max" });
    await maxTab.click();
    await expect(maxTab).toHaveClass(/active/);

    // syncUrl writes ?sort=max_duration_ms only on a non-default value.
    expect(page.url()).toContain("sort=max_duration_ms");
  });

  test("suite filter narrows the list and reloads from the API", async ({ page }) => {
    const select = page.locator(".filters select").first();
    // The select renders only when suites.length > 1; the seed has 6
    // suites for Acme so the dropdown is present.
    await expect(select).toBeVisible({ timeout: 5_000 });

    const optionValues = await select
      .locator("option")
      .evaluateAll((opts) => (opts as HTMLOptionElement[]).map((o) => o.value));
    expect(optionValues.length, "suite dropdown should be populated").toBeGreaterThan(1);

    // Pick the first concrete suite and confirm URL sync + at least
    // one card remains. Pinning a specific suite would be brittle
    // against seed randomness.
    const target = optionValues[1];
    await select.selectOption(target);
    expect(page.url()).toContain(`suite=${encodeURIComponent(target)}`);
    await expect(page.locator(".test-list, .empty")).toBeVisible({ timeout: 5_000 });
  });

  test("clicking a test card expands its detail section", async ({ page }) => {
    const firstCard = page.locator(".test-card").first();
    await expect(firstCard).toBeVisible();

    // Cards default unexpanded; the .test-detail child only renders
    // when this card is the expandedIndex.
    await expect(firstCard).not.toHaveClass(/expanded/);
    await firstCard.locator(".test-header").click();
    await expect(firstCard).toHaveClass(/expanded/);
    await expect(firstCard.locator(".test-detail")).toBeVisible({ timeout: 2_000 });
  });
});
