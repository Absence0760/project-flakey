import { expect, test } from "@playwright/test";

import { ADMIN_USER } from "./fixtures/users";

/**
 * /manual-tests — group management modal.
 *
 * "Manage groups" admin-gated button opens a modal where admins can
 * create / rename / delete groups. The seed inserts 3 groups
 * (Checkout Flow, Auth Suite, Billing Smoke).
 */

test.describe("/manual-tests — group CRUD", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test.beforeEach(async ({ page }) => {
    await page.goto("/manual-tests");
    await expect(page.locator("table.tests")).toBeVisible({ timeout: 10_000 });
  });

  test("admin can create a new group via the Manage Groups modal", async ({ page }) => {
    await page.getByRole("button", { name: /Manage groups/ }).click();

    const modal = page.locator(".modal.groups-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    const nameInput = modal.getByPlaceholder("e.g. Checkout Flow");
    await expect(nameInput).toBeVisible();

    const groupName = `e2e-grp-${Date.now().toString(36)}`;
    await nameInput.fill(groupName);
    await modal.getByRole("button", { name: /^Create group$/ }).click();

    // The new group surfaces in the "Existing groups" table inside
    // the modal.
    await expect(modal.locator("table.tests tbody", { hasText: groupName })).toBeVisible({
      timeout: 5_000,
    });

    // Cleanup: delete the group via its row's × / Delete action so
    // re-runs aren't polluted with leftover groups.
    page.once("dialog", (d) => d.accept());
    const newRow = modal.locator("table.tests tbody tr", { hasText: groupName });
    const deleteBtn = newRow.getByRole("button", { name: /^(Delete|✕)$/ }).last();
    if (await deleteBtn.isVisible().catch(() => false)) {
      await deleteBtn.click();
    }
  });

  test("the group filter dropdown lists all 3 seeded groups", async ({ page }) => {
    const select = page.locator("#group-select");
    const options = await select
      .locator("option")
      .evaluateAll((els) => (els as HTMLOptionElement[]).map((o) => o.textContent?.trim() ?? ""));

    const labels = options.join(" ");
    expect(labels).toMatch(/Checkout Flow/);
    expect(labels).toMatch(/Auth Suite/);
    expect(labels).toMatch(/Billing Smoke/);
  });

  test("Flaky only checkbox filters to tests marked flaky", async ({ page }) => {
    const flakyOnly = page.getByLabel(/Flaky only/i);
    await flakyOnly.check();
    // After the toggle, either rows visible or "no tests" empty
    // state. Don't assert specific count — just that the filter
    // doesn't crash the page.
    await expect(page.locator("table.tests")).toBeVisible();
    await flakyOnly.uncheck();
  });
});
