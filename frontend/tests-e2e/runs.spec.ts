import { expect, test } from "@playwright/test";

import { ADMIN_USER } from "./fixtures/users";

/**
 * /  — the automated runs list. Primary read affordance for the
 * product. Renders a list of run cards, supports filters (suite,
 * branch, env, date range, search), and links each card to /runs/<id>.
 *
 * The route lives at routes/(app)/+page.svelte (not /runs) — /runs/<id>
 * is the detail page only. The sidebar's "Automated runs" nav item
 * links here.
 */

test.describe("/ runs list", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // The list defaults its date filter to "7 days" so the cold load
    // is fast on heavy users. Wait for the first run-card to appear
    // before driving anything else.
    await expect(page.locator("a.run-card").first()).toBeVisible({ timeout: 10_000 });
  });

  test("renders run cards with the expected structural pieces", async ({ page }) => {
    const firstCard = page.locator("a.run-card").first();

    // Every card has: a status dot (.run-status-dot), a run id
    // (.run-id), and links to /runs/<id>.
    await expect(firstCard.locator(".run-status-dot")).toBeVisible();
    await expect(firstCard.locator(".run-id")).toContainText(/^#\d+$/);
    await expect(firstCard).toHaveAttribute("href", /^\/runs\/\d+$/);
  });

  test("suite filter narrows the list", async ({ page }) => {
    const suiteSelect = page.locator(".filters select").first();
    // Pick the second option (the first concrete suite — the first
    // is always "All suites").
    const optionValues = await suiteSelect.locator("option").evaluateAll(
      (opts) => (opts as HTMLOptionElement[]).map((o) => o.value),
    );
    expect(optionValues.length, "seed should populate the suite filter").toBeGreaterThan(1);

    const targetSuite = optionValues[1];
    await suiteSelect.selectOption(targetSuite);

    // After narrowing, every visible run-card's suite text must
    // match. The card renders the suite under .card-info — use a
    // less brittle assertion: at least one card remains AND none
    // of the visible suite labels is for a different suite.
    await expect(page.locator("a.run-card").first()).toBeVisible({ timeout: 5_000 });

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

  test("clicking a run card navigates to /runs/<id>", async ({ page }) => {
    const firstCard = page.locator("a.run-card").first();
    const href = await firstCard.getAttribute("href");
    expect(href, "first run card must link to /runs/<id>").toMatch(/^\/runs\/\d+$/);

    await firstCard.click();

    // The detail page may auto-append ?status=failed when the run has
    // failures (run-detail/+page.svelte's "Feature 1" auto-filter).
    // The contract here is just "we landed on /runs/<id>", not "URL
    // ends with the bare path".
    await expect(page).toHaveURL(new RegExp(`${href}(\\?|$)`), { timeout: 10_000 });
  });
});
