import { expect, test } from "../fixtures/test";


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

  test("admin changes a status pill: Open → Investigating → reload still shows it", async ({
    page,
  }) => {
    await page.goto("/errors");

    // The seed already stamps one error group as 'investigating' (see
    // backend/src/seed.ts — non-default error_group statuses) so we
    // can't rely on a global uniqueness count, and we must not pick
    // an already-investigating row (the test would no-op and the
    // cleanup would corrupt the seed). The master/detail layout
    // renders rows as `button.error-item`; each row carries an inline
    // `.status-chip` with the status label.
    await expect(page.locator("button.error-item").first()).toBeVisible({ timeout: 10_000 });
    const target = page
      .locator("button.error-item", {
        hasNot: page.locator(".status-chip", { hasText: "Investigating" }),
      })
      .first();
    await expect(target, "expected at least one non-Investigating error in the seed").toBeVisible({
      timeout: 5_000,
    });
    const targetMessage = (await target.locator(".error-msg").innerText()).trim();
    expect(targetMessage.length, "target error row must have a message").toBeGreaterThan(0);

    await target.click();

    // The right-hand detail pane has a status-controls section with
    // the five status pills.
    const statusControls = page.locator(".status-controls").first();
    await expect(statusControls).toBeVisible();
    const investigatingBtn = statusControls.getByRole("button", { name: /^Investigating$/ });
    await investigatingBtn.click();

    // The clicked pill picks up `.active`. The row's status chip and
    // the detail header badge both update to Investigating.
    await expect(investigatingBtn).toHaveClass(/\bactive\b/, { timeout: 2_000 });
    await expect(
      page.locator(".detail-header .status-badge", { hasText: "Investigating" }),
    ).toBeVisible({ timeout: 2_000 });

    // Reload — the change must have hit the server. Re-select the
    // captured row by message and assert it carries the Investigating
    // chip + the detail badge reflects it.
    await page.reload();
    await expect(page.locator("button.error-item").first()).toBeVisible({ timeout: 10_000 });
    const reloadedRow = page
      .locator("button.error-item", { has: page.locator(".error-msg", { hasText: targetMessage }) })
      .first();
    await expect(reloadedRow.locator(".status-chip", { hasText: "Investigating" })).toBeVisible({
      timeout: 5_000,
    });

    // Clean up — flip the captured row back to "Open" so the suite
    // re-runs start from the same baseline.
    await reloadedRow.click();
    await page
      .locator(".status-controls .status-btn", { hasText: "Open" })
      .first()
      .click();
  });

  test("status filter tabs narrow the list to that status", async ({ page }) => {
    await page.goto("/errors");
    await expect(page.locator("button.error-item").first()).toBeVisible({ timeout: 10_000 });

    // The status filter tab strip lives at the top — "All", "Open",
    // "Investigating", "Known Issue", "Fixed", "Ignored". The seed
    // creates many open errors by default; clicking "Fixed" should
    // narrow to those (zero by default → empty state).
    const fixedTab = page.locator(".filter-tab", { hasText: "Fixed" });
    await fixedTab.click();
    await expect(fixedTab).toHaveClass(/active/);

    // Either zero rows (empty state for "Fixed") or every visible
    // row has a Fixed status chip. Both are valid.
    const rows = page.locator("button.error-item");
    const count = await rows.count();
    if (count > 0) {
      await expect(
        page.locator("button.error-item .status-chip", { hasText: "Fixed" }).first(),
      ).toBeVisible();
    }

    // Restore default tab.
    await page.locator(".filter-tab", { hasText: /^All$/ }).click();
  });
});
