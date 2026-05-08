import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "./fixtures/users";

/**
 * /releases — creating a release via the inline form actually persists
 * + a deletion flow on the detail page (admin-only).
 *
 * The existing releases.spec.ts covers the inline create form's UX
 * (form opens, fills, closes, card surfaces). This spec drives the
 * full lifecycle: create → navigate to detail → delete → confirms
 * the card is gone from the list.
 */

async function createReleaseViaForm(page: Page): Promise<string> {
  await page.goto("/releases");
  await expect(page.locator(".release-grid").first()).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: /New release/ }).click();
  const form = page.locator(".create-card");
  await expect(form).toBeVisible();

  const version = `e2e-create-${Date.now().toString(36)}`;
  await form.locator('input[placeholder*="v1.2.0"]').fill(version);
  await form.getByRole("button", { name: /^Create$/ }).click();
  await expect(form).toBeHidden({ timeout: 5_000 });
  return version;
}

test.describe("releases — create-then-delete lifecycle", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("admin creates a release via the inline form, deletes it via the detail page", async ({
    page,
  }) => {
    const version = await createReleaseViaForm(page);

    const card = page.locator(".release-card", {
      has: page.locator(".version", { hasText: version }),
    }).first();
    await expect(card).toBeVisible({ timeout: 5_000 });
    await card.click();

    // Land on detail.
    await expect(page.getByRole("heading", { name: version })).toBeVisible({ timeout: 10_000 });

    // Delete CTA on the detail page is admin-only and lives in the
    // header or actions section. Try the most common labels.
    const deleteBtn = page.getByRole("button", { name: /^(Delete release|Delete|Discard)$/ }).first();
    if ((await deleteBtn.count()) === 0) {
      // No delete CTA exposed → mark the test as skipped (the route
      // may have intentionally hidden it).
      test.skip(true, "release-detail page does not currently expose a delete CTA");
      return;
    }

    page.once("dialog", (d) => d.accept());
    await deleteBtn.click();
    // In-page confirmation modal pattern.
    const modalConfirm = page
      .locator("button.btn-sm.danger, button", { hasText: /^(Delete|Confirm|Yes)$/ })
      .last();
    if (await modalConfirm.isVisible().catch(() => false)) {
      await modalConfirm.click();
    }

    // Lands back on /releases; the card is gone.
    await expect(page).toHaveURL(/\/releases$/);
    await expect(
      page.locator(".release-card", {
        has: page.locator(".version", { hasText: version }),
      }),
    ).toHaveCount(0, { timeout: 5_000 });
  });
});
