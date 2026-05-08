import { expect, test } from "@playwright/test";

import { ADMIN_USER } from "./fixtures/users";

/**
 * /errors — change a fingerprint's status and verify it persists.
 *
 * Each error group has a status picker (Open / Investigating / Known
 * Issue / Fixed / Ignored). Clicking flips the active status pill,
 * surfaces a corresponding badge in the header, and (importantly)
 * persists across reload via PATCH /errors/:fingerprint.
 *
 * The seed creates aggregated errors out of failed tests. The first
 * error group is stable enough to drive — we don't pin the
 * fingerprint, just walk through the per-group status flow on
 * whichever fingerprint sorts to the top.
 */

test.describe("/errors — status CRUD", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("admin changes a status pill: Open → Investigating → reload still shows it", async ({
    page,
  }) => {
    await page.goto("/errors");

    // First error header lands; click to expand.
    const firstHeader = page.locator(".error-header").first();
    await expect(firstHeader).toBeVisible({ timeout: 10_000 });
    await firstHeader.click();

    // The expanded body has a status-controls section with 5 pills.
    const statusControls = page.locator(".status-controls").first();
    await expect(statusControls).toBeVisible();
    const investigatingBtn = statusControls.getByRole("button", { name: /^Investigating$/ });
    await investigatingBtn.click();

    // The clicked pill picks up `.active`. The header badge text
    // updates too (statusInfo(err.status).label).
    await expect(investigatingBtn).toHaveClass(/\bactive\b/, { timeout: 2_000 });

    // Reload — the change must have hit the server. The first group
    // could re-sort to a different position depending on aggregation
    // ordering; we look for a group whose badge reads "Investigating"
    // anywhere on the page.
    await page.reload();
    await expect(page.locator(".error-header").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".status-badge", { hasText: "Investigating" })).toHaveCount(1, {
      timeout: 5_000,
    });

    // Clean up — flip the status back to "Open" so the suite re-runs
    // start from the same baseline.
    await page.locator(".error-header", { has: page.locator(".status-badge", { hasText: "Investigating" }) }).first().click();
    await page
      .locator(".status-controls .status-btn", { hasText: "Open" })
      .first()
      .click();
  });

  test("status filter tabs narrow the list to that status", async ({ page }) => {
    await page.goto("/errors");
    await expect(page.locator(".error-header").first()).toBeVisible({ timeout: 10_000 });

    // The status filter tab strip lives at the top — "All", "Open",
    // "Investigating", "Known Issue", "Fixed", "Ignored". The seed
    // creates many open errors by default; clicking "Fixed" should
    // narrow to those (zero by default → empty state).
    const fixedTab = page.locator(".filter-tab", { hasText: "Fixed" });
    await fixedTab.click();
    await expect(fixedTab).toHaveClass(/active/);

    // Either zero error-headers (empty state for "Fixed") or every
    // visible header has a Fixed badge. Both are valid.
    const headers = page.locator(".error-header");
    const count = await headers.count();
    if (count > 0) {
      await expect(
        page.locator(".error-header .status-badge", { hasText: "Fixed" }).first(),
      ).toBeVisible();
    }

    // Restore default tab.
    await page.locator(".filter-tab", { hasText: /^All$/ }).click();
  });
});
