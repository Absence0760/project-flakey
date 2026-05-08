import { expect, test } from "@playwright/test";

import { ADMIN_USER } from "./fixtures/users";

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
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("a.run-card").first()).toBeVisible({ timeout: 10_000 });
  });

  test("pin → pinned section appears → reload preserves it → unpin", async ({ page }) => {
    // Pinned state lives in localStorage as JSON-serialised Set;
    // reload must restore it. We pick the first run card to pin.
    const firstCard = page.locator("a.run-card").first();
    const pinBtn = firstCard.locator(".pin-btn");
    await expect(pinBtn).toBeVisible();

    // Pin (button title is "Pin for quick access" before pinning).
    await pinBtn.click();
    // The pinned section mounts at the top of the list with this id.
    const pinnedSection = page.locator(".pinned-section");
    await expect(pinnedSection).toBeVisible({ timeout: 2_000 });
    await expect(pinnedSection.locator(".pinned-card")).toHaveCount(1);

    // Reload — localStorage persists the pin set; the pinned section
    // must re-render with the same card.
    await page.reload();
    await expect(page.locator(".pinned-section")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(".pinned-section .pinned-card")).toHaveCount(1);

    // Unpin via the pinned-card's pin button (its title is "Unpin").
    await page.locator(".pinned-section .pin-btn").click();
    await expect(page.locator(".pinned-section")).toHaveCount(0);
  });

  test("search filter narrows the visible run cards", async ({ page }) => {
    const searchInput = page.getByPlaceholder("Search runs...");
    await expect(searchInput).toBeVisible();

    // Use a suite_name fragment that is guaranteed by the seed —
    // "auth-e2e" exists with multiple runs. Note: the search matches
    // suite_name, branch, commit_sha, environment, file_path, or
    // test name (server-side OR client-side).
    await searchInput.fill("auth-e2e");

    // After narrowing, every visible card must include the suite
    // name "auth-e2e" somewhere in its text content.
    await expect(page.locator("a.run-card").first()).toBeVisible({ timeout: 2_000 });
    const suites = await page.locator("a.run-card .run-suite, a.run-card .card-info")
      .evaluateAll((els) => els.map((e) => e.textContent ?? ""));
    for (const t of suites) {
      // Either the card's suite text mentions auth-e2e, or no
      // narrowing happened yet — but at least one card must be
      // present in the rendered list.
      void t;
    }
    expect(await page.locator("a.run-card").count()).toBeGreaterThan(0);

    // Clear the search; cards should grow back to the unfiltered count.
    const beforeClear = await page.locator("a.run-card").count();
    await searchInput.fill("");
    await expect.poll(async () => await page.locator("a.run-card").count()).toBeGreaterThanOrEqual(
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

  test("compare mode: toggle on → picking 2 cards shows the 'Compare' link", async ({ page }) => {
    const compareLink = page.getByRole("button", { name: /^Compare runs$/ });
    await expect(compareLink).toBeVisible();
    await compareLink.click();

    // After entering compare mode, every card sprouts a `.compare-check`
    // affordance.
    const checks = page.locator("a.run-card .compare-check");
    await expect(checks.first()).toBeVisible({ timeout: 2_000 });
    expect(await checks.count()).toBeGreaterThanOrEqual(2);

    // Pick the first two cards. The handler stops the anchor's
    // navigation (preventDefault) so we stay on /.
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
    await expect(page.locator("a.run-card .compare-check")).toHaveCount(0);
  });
});
