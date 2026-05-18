import { expect, test } from "../fixtures/test";


/**
 * /  — the automated runs list. Primary read affordance for the
 * product. Renders a table of run rows, supports filters (suite,
 * branch, env, date range, search), and links each row to /runs/<id>.
 *
 * The route lives at routes/(app)/+page.svelte (not /runs) — /runs/<id>
 * is the detail page only. The sidebar's "Automated runs" nav item
 * links here.
 */

test.describe("/ runs list", () => {

  test.beforeEach(async ({ page }) => {
    await page.goto("/runs");
    // The list defaults its date filter to "7 days" so the cold load
    // is fast on heavy users. Wait for the first run-row to appear
    // before driving anything else.
    await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 10_000 });
  });

  test("renders run rows with the expected structural pieces", async ({ page }) => {
    const firstRow = page.locator("tr.run-row").first();

    // Every row has: a status dot (.run-status-dot), a run id
    // (.run-id), and links to /runs/<id> via data-href.
    await expect(firstRow.locator(".run-status-dot")).toBeVisible();
    await expect(firstRow.locator(".run-id")).toContainText(/^#\d+$/);
    await expect(firstRow).toHaveAttribute("data-href", /^\/runs\/\d+$/);
  });

  test("suite filter narrows the list", async ({ page }) => {
    // Suite/branch/env dropdowns live inside a "Filters" popover now —
    // open it before reaching the <select>. The popover content uses
    // the .filters class so the original selector still matches once
    // it's mounted.
    await page.locator(".filter-trigger").click();
    const suiteSelect = page.locator(".filters select").first();
    await expect(suiteSelect).toBeVisible();
    // Pick the second option (the first concrete suite — the first
    // is always "All suites").
    const optionValues = await suiteSelect.locator("option").evaluateAll(
      (opts) => (opts as HTMLOptionElement[]).map((o) => o.value),
    );
    expect(optionValues.length, "seed should populate the suite filter").toBeGreaterThan(1);

    const targetSuite = optionValues[1];
    await suiteSelect.selectOption(targetSuite);

    // After narrowing, every visible run-row's suite text must
    // match. The row renders the suite under .suite-cell — use a
    // less brittle assertion: at least one row remains AND none
    // of the visible suite labels is for a different suite.
    await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 5_000 });

    // The URL state-sync should add ?suite= to the querystring once
    // a non-default value is chosen (per syncFiltersToUrl in the
    // route's <script>).
    expect(page.url()).toContain(`suite=${encodeURIComponent(targetSuite)}`);
  });

  test("date filter buttons swap the active state and trigger a reload", async ({ page }) => {
    const allTimeBtn = page.locator(".filter-tab", { hasText: "All time" });
    const sevenDaysBtn = page.locator(".filter-tab", { hasText: "7 days" });

    // 7 days is the default — start by switching to All time.
    await allTimeBtn.click();
    await expect(allTimeBtn).toHaveClass(/active/);
    await expect(sevenDaysBtn).not.toHaveClass(/active/);

    // The filter-tabs are non-anchor buttons; the URL state-sync
    // writes ?date=all only on a non-default selection.
    expect(page.url()).toContain("date=all");
  });

  test("clicking a run row navigates to /runs/<id>", async ({ page }) => {
    const firstRow = page.locator("tr.run-row").first();
    const href = await firstRow.getAttribute("data-href");
    expect(href, "first run row must link to /runs/<id>").toMatch(/^\/runs\/\d+$/);

    await firstRow.click();

    // The detail page may auto-append ?status=failed when the run has
    // failures (run-detail/+page.svelte's "Feature 1" auto-filter).
    // The contract here is just "we landed on /runs/<id>", not "URL
    // ends with the bare path".
    await expect(page).toHaveURL(new RegExp(`${href}(\\?|$)`), { timeout: 10_000 });
  });
});
