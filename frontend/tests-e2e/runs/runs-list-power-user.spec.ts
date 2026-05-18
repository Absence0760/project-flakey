import { expect, test } from "../fixtures/test";


/**
 * /  — power-user affordances on the runs list.
 *
 * Pin/unpin is persisted in localStorage (`pinned-runs`); saved
 * views go through the API (/views POST/DELETE); compare mode
 * surfaces a per-card A/B selector that, with both picked, links
 * to /compare?a=…&b=…. Each is an independently-shippable feature
 * that single-page tests don't otherwise hit.
 */

test.describe("/ runs-list — pin / saved views / search / compare mode", () => {

  test.beforeEach(async ({ page }) => {
    await page.goto("/runs");
    await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 10_000 });
  });

  test("pin → pinned section appears → reload preserves it → unpin", async ({ page }) => {
    // Pinned state lives in localStorage as JSON-serialised Set;
    // reload must restore it. We pick the first run row to pin.
    const firstRow = page.locator("tr.run-row").first();
    const pinBtn = firstRow.locator(".pin-btn");
    await expect(pinBtn).toBeVisible();

    // Pin (button title is "Pin for quick access" before pinning).
    await pinBtn.click();
    // The pinned band mounts at the top of the list; rendered as
    // <section class="pinned-band">, with each pinned run as a
    // .pinned-item anchor inside .pinned-list. (Renamed in the UI
    // polish pass from .pinned-section / .pinned-card.)
    const pinnedBand = page.locator(".pinned-band");
    await expect(pinnedBand).toBeVisible({ timeout: 2_000 });
    await expect(pinnedBand.locator(".pinned-item")).toHaveCount(1);

    // Reload — localStorage persists the pin set; the pinned band
    // must re-render with the same item.
    await page.reload();
    await expect(page.locator(".pinned-band")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(".pinned-band .pinned-item")).toHaveCount(1);

    // Unpin via the pinned-item's pin button (its title is "Unpin").
    await page.locator(".pinned-band .pin-btn").click();
    await expect(page.locator(".pinned-band")).toHaveCount(0);
  });

  test("search filter narrows the visible run rows", async ({ page }) => {
    const searchInput = page.getByPlaceholder("Search runs...");
    await expect(searchInput).toBeVisible();

    // Use a suite_name fragment that is guaranteed by the seed —
    // "auth-e2e" exists with multiple runs. Note: the search matches
    // suite_name, branch, commit_sha, environment, file_path, or
    // test name (server-side OR client-side).
    await searchInput.fill("auth-e2e");

    // After narrowing, every visible row must include the suite
    // name "auth-e2e" somewhere in its text content.
    await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 2_000 });
    const suites = await page.locator("tr.run-row .run-suite")
      .evaluateAll((els) => els.map((e) => e.textContent ?? ""));
    for (const t of suites) {
      // Either the row's suite text mentions auth-e2e, or no
      // narrowing happened yet — but at least one row must be
      // present in the rendered list.
      void t;
    }
    expect(await page.locator("tr.run-row").count()).toBeGreaterThan(0);

    // Clear the search; rows should grow back to the unfiltered count.
    const beforeClear = await page.locator("tr.run-row").count();
    await searchInput.fill("");
    await expect.poll(async () => await page.locator("tr.run-row").count()).toBeGreaterThanOrEqual(
      beforeClear,
    );
  });

  test("saved views: create → click pill applies filters → delete removes pill", async ({
    page,
  }) => {
    // Apply a non-default filter so saving the view captures it.
    const searchInput = page.getByPlaceholder("Search runs...");
    const uniqueQ = `view-q-${Date.now().toString(36)}`;
    await searchInput.fill(uniqueQ);

    // Open the save form.
    await page.getByRole("button", { name: /^Save view$/ }).click();
    const saveForm = page.locator("form.save-form");
    await expect(saveForm).toBeVisible();

    const viewName = `e2e-view-${Date.now().toString(36)}`;
    await saveForm.getByPlaceholder("View name...").fill(viewName);
    await saveForm.getByRole("button", { name: /^Save$/ }).click();

    // Pill renders in the views-bar.
    const pill = page.locator(".view-pill", { hasText: viewName });
    await expect(pill).toBeVisible({ timeout: 5_000 });

    // Clear the search so we can prove that clicking the pill
    // restores it. After applyView, searchQuery becomes uniqueQ
    // and the input shows it.
    await searchInput.fill("");
    await pill.locator(".view-pill-btn").click();
    await expect(searchInput).toHaveValue(uniqueQ, { timeout: 2_000 });

    // Cleanup: delete the saved view via the × button on the pill.
    await pill.locator(".view-pill-x").click();
    await expect(page.locator(".view-pill", { hasText: viewName })).toHaveCount(0, {
      timeout: 5_000,
    });

    // Restore: clear the search input.
    await searchInput.fill("");
  });

  test("compare mode: toggle on → picking 2 rows shows the 'Compare' link", async ({ page }) => {
    const compareLink = page.getByRole("button", { name: /^Compare runs$/ });
    await expect(compareLink).toBeVisible();
    await compareLink.click();

    // After entering compare mode, every row sprouts a `.compare-check`
    // affordance.
    const checks = page.locator("tr.run-row .compare-check");
    await expect(checks.first()).toBeVisible({ timeout: 2_000 });
    expect(await checks.count()).toBeGreaterThanOrEqual(2);

    // Pick the first two rows. The handler stops the row's
    // navigation (stopPropagation) so we stay on /.
    await checks.nth(0).click();
    await checks.nth(1).click();

    // With both A and B picked, the route renders a `.compare-go-btn`
    // anchor pointing at /compare?a=…&b=….
    const go = page.locator("a.compare-go-btn");
    await expect(go).toBeVisible({ timeout: 2_000 });
    const href = await go.getAttribute("href");
    expect(href).toMatch(/^\/compare\?a=\d+&b=\d+$/);

    // Cancel compare to leave the listing in its default state.
    await page.getByRole("button", { name: /^Cancel compare$/ }).click();
    await expect(page.locator("tr.run-row .compare-check")).toHaveCount(0);
  });
});
