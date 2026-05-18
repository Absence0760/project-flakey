import { expect, test } from "../fixtures/test";


/**
 * /flaky — the headline product feature.
 *
 * "Flaky tests" are tests that alternate between passing and failing
 * across recent runs. Backend computes them via fetchFlakyTests
 * with a configurable run-window (default 30) and suite filter.
 *
 * Whether the seed produces any flaky tests depends on its random
 * seed; we assert on the page chrome (filters + run-window tabs +
 * either the summary line OR the empty state) rather than on a
 * specific count.
 */

test.describe("/flaky", () => {

  test.beforeEach(async ({ page }) => {
    await page.goto("/flaky");
  });

  test("renders the header description + filter chrome", async ({ page }) => {
    // Description is the page's de facto title (no h1 currently).
    await expect(
      page.getByText("Tests that alternate between passing and failing across recent runs."),
    ).toBeVisible({ timeout: 10_000 });

    // Suite filter (defaults to "All suites").
    const suiteSelect = page.locator(".filters select").first();
    await expect(suiteSelect).toBeVisible();
    await expect(suiteSelect).toHaveValue("all");

    // Run-window tabs — the route renders one button per
    // [10, 20, 30, 50, 100]. The default is 30.
    //
    // Scope to the .filters container's tabs — there's a second
    // .filter-tabs block in the sort bar (Flaky rate / Flips /
    // Failures / Last seen) that would inflate the count.
    const tabs = page.locator(".filters .filter-tabs .filter-tab");
    await expect(tabs).toHaveCount(5);
    await expect(tabs.filter({ hasText: "30 runs" })).toHaveClass(/active/);
  });

  test("clicking a different run-window tab updates the active state and triggers reload", async ({
    page,
  }) => {
    const tabs = page.locator(".filters .filter-tabs .filter-tab");
    await expect(tabs).toHaveCount(5, { timeout: 10_000 });

    const fiftyTab = tabs.filter({ hasText: "50 runs" });
    await fiftyTab.click();
    await expect(fiftyTab).toHaveClass(/active/);
    // The previously-active 30-runs tab loses .active.
    await expect(tabs.filter({ hasText: "30 runs" })).not.toHaveClass(/active/);

    // The reload() call after the tab click swaps the body content
    // between Loading / list / empty. Wait for one of the terminal
    // states to settle. We can't know which without reading the seed
    // randomness, so assert on either summary line OR empty pane
    // becoming visible.
    const summaryOrEmpty = page.locator(".summary, .empty").first();
    await expect(summaryOrEmpty).toBeVisible({ timeout: 10_000 });
  });
});
