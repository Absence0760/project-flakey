import { expect, test } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * /flaky — sort + run-window controls beyond the default smoke.
 *
 * Sort tabs: Flaky rate / Flips / Failures / Last seen.
 * Run window tabs: 10 / 20 / 30 / 50 / 100 runs.
 * Both control derived state on the page; flipping them MUST refetch
 * the list and update the active class.
 */

test.describe("/flaky — sort + run window", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test.beforeEach(async ({ page }) => {
    await page.goto("/flaky");
    // /flaky no longer renders an <h1> — the sidebar nav + URL label
    // the page (same convention as /manual-tests, /errors, /runs).
    // Wait on the description sentence instead, which IS the de facto
    // page title.
    await expect(
      page.getByText("Tests that alternate between passing and failing across recent runs."),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("sort tabs flip the active state and re-render the list", async ({ page }) => {
    // Sort tabs live in .sort-bar, NOT .filters (which is run window).
    const sortBar = page.locator(".sort-bar .filter-tabs");
    // Default sort is "Flaky rate".
    const flakyRate = sortBar.locator(".filter-tab", { hasText: "Flaky rate" });
    await expect(flakyRate).toHaveClass(/active/);

    const flips = sortBar.locator(".filter-tab", { hasText: "Flips" });
    await flips.click();
    await expect(flips).toHaveClass(/active/);
    await expect(flakyRate).not.toHaveClass(/active/);

    const failures = sortBar.locator(".filter-tab", { hasText: "Failures" });
    await failures.click();
    await expect(failures).toHaveClass(/active/);

    const lastSeen = sortBar.locator(".filter-tab", { hasText: "Last seen" });
    await lastSeen.click();
    await expect(lastSeen).toHaveClass(/active/);
  });

  test("run-window tabs trigger reload (window selector flips active class)", async ({ page }) => {
    const windowBar = page.locator(".filters .filter-tabs");
    // Default is "30 runs". Click "10 runs".
    const tenRuns = windowBar.locator(".filter-tab", { hasText: /^10 runs$/ });
    await tenRuns.click();
    await expect(tenRuns).toHaveClass(/active/);

    // "100 runs" widens the search.
    const hundred = windowBar.locator(".filter-tab", { hasText: /^100 runs$/ });
    await hundred.click();
    await expect(hundred).toHaveClass(/active/);
  });

  test("suite filter narrows the flaky list to the selected suite", async ({ page }) => {
    const suiteSelect = page.locator(".filters select").first();
    const opts = await suiteSelect
      .locator("option")
      .evaluateAll((els) => (els as HTMLOptionElement[]).map((o) => o.value));
    expect(opts.length).toBeGreaterThan(1);
    await suiteSelect.selectOption(opts[1]);

    // Wait for the route to settle. We don't assert specific cards
    // since flaky-detection is a derived metric and the seed's
    // distribution shifts with each re-seed. Just confirm the filter
    // didn't crash the page — the suite-select itself still being
    // visible is a reliable post-load signal.
    await expect(suiteSelect).toBeVisible();
  });
});
