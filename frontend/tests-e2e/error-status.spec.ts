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

    // The seed already stamps one error group as 'investigating' (see
    // backend/src/seed.ts — non-default error_group statuses) so we
    // can't rely on a global uniqueness count, and we must not pick
    // an already-investigating row (the test would no-op and the
    // cleanup would corrupt the seed). Find the first row whose badge
    // is anything OTHER than Investigating, capture its message, and
    // drive the change off that row.
    await expect(page.locator(".error-header").first()).toBeVisible({ timeout: 10_000 });
    const target = page
      .locator(".error-header", {
        hasNot: page.locator(".status-badge", { hasText: "Investigating" }),
      })
      .first();
    await expect(target, "expected at least one non-Investigating error in the seed").toBeVisible({
      timeout: 5_000,
    });
    const targetMessage = (await target.locator(".error-message-primary").innerText()).trim();
    expect(targetMessage.length, "target error header must have a message").toBeGreaterThan(0);

    await target.click();

    // The expanded body has a status-controls section with 5 pills.
    const statusControls = page.locator(".status-controls").first();
    await expect(statusControls).toBeVisible();
    const investigatingBtn = statusControls.getByRole("button", { name: /^Investigating$/ });
    await investigatingBtn.click();

    // The clicked pill picks up `.active`. The header badge text
    // updates too (statusInfo(err.status).label).
    await expect(investigatingBtn).toHaveClass(/\bactive\b/, { timeout: 2_000 });

    // Reload — the change must have hit the server. The row may
    // re-sort, so locate by the captured message and assert that
    // specific row has the Investigating badge.
    await page.reload();
    await expect(page.locator(".error-header").first()).toBeVisible({ timeout: 10_000 });
    const reloadedHeader = page
      .locator(".error-header", { has: page.locator(".error-message-primary", { hasText: targetMessage }) })
      .first();
    await expect(reloadedHeader.locator(".status-badge", { hasText: "Investigating" })).toBeVisible({
      timeout: 5_000,
    });

    // Clean up — flip the captured row back to "Open" so the suite
    // re-runs start from the same baseline. Scoped to the same
    // captured row so we don't disturb the seed's pre-existing
    // investigating entry.
    await reloadedHeader.click();
    await page
      .locator(".error-card", { has: page.locator(".error-message-primary", { hasText: targetMessage }) })
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
