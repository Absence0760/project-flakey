import { expect, test } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * /manual-tests — requirement-link CRUD on the test detail modal.
 *
 * Each manual test can be linked to ≥1 requirement key (Jira issue,
 * GitHub issue, etc.). The link/unlink controls live inside the
 * test-detail modal under the "Requirements" heading. Both POST
 * /manual-tests/:id/requirements and DELETE /…/requirements/:reqId
 * are admin-gated server-side; the form itself is admin-gated in
 * the route. ADMIN_USER is the Acme Corp owner so the form renders.
 *
 * The seed inserts requirements on a few seeded tests already (e.g.
 * ACME-501 across two tests, gh#284 across two) — but the spec here
 * adds a NEW key with a unique value so it's idempotent across
 * repeated runs without coupling to the existing seed links.
 */

test.describe("manual-test requirements CRUD", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("admin can link a new requirement and unlink it again", async ({ page }) => {
    await page.goto("/manual-tests");
    await expect(page.locator("table.tests")).toBeVisible({ timeout: 10_000 });

    // Use the same stable seeded title that manual-tests.spec uses to
    // open the detail modal (it has an enabled run + the standard
    // 3-step template, and never shifts in the table).
    await page
      .locator("table.tests tbody tr.test-row", {
        hasText: "Verify PDF export of run report",
      })
      .first()
      .click();

    const modal = page.locator(".modal").last();
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(
      modal.getByRole("heading", { name: "Verify PDF export of run report", exact: true }),
    ).toBeVisible();

    // Scroll the Requirements heading into view inside the modal —
    // the modal's body scrolls; Playwright's auto-scroll handles
    // visibility for actions but explicit scrolling makes the intent
    // clearer.
    const reqHeading = modal.getByRole("heading", { name: "Requirements", exact: true });
    await reqHeading.scrollIntoViewIfNeeded();
    await expect(reqHeading).toBeVisible();

    // The add-req row is admin-only; ADMIN_USER sees it.
    const addRow = modal.locator(".add-req");
    await expect(addRow).toBeVisible();

    const uniqueKey = `E2E-${Date.now().toString(36).toUpperCase()}`;
    await addRow.locator(".req-input-key").fill(uniqueKey);
    await addRow
      .locator(".req-input-url")
      .fill("https://example.com/issues/" + uniqueKey);
    await addRow.locator(".req-input-title").fill("e2e link smoke");

    const linkBtn = addRow.getByRole("button", { name: /^\+\s*Link$/ });
    await expect(linkBtn).toBeEnabled();
    await linkBtn.click();

    // The list should now contain the new key. Backend POST returns
    // the inserted row; route refetches and re-renders.
    const reqList = modal.locator("ul.req-list");
    await expect(reqList).toBeVisible({ timeout: 5_000 });
    const newRow = reqList.locator("li", { hasText: uniqueKey });
    await expect(newRow).toBeVisible({ timeout: 5_000 });
    await expect(newRow.locator(".req-key", { hasText: uniqueKey })).toBeVisible();

    // The provider badge gets auto-inferred from the URL — for an
    // example.com URL it falls back to a generic "link" or similar.
    // We don't assert the specific provider value (auto-infer is
    // brittle to coupling); we assert the badge element exists.
    await expect(newRow.locator(".provider-badge")).toBeVisible();

    // Unlink: per-row delete button (✕) is admin-only and triggers
    // DELETE /manual-tests/:id/requirements/:reqId.
    await newRow.locator('button.icon-btn.danger[title="Unlink"]').click();

    // Row goes away.
    await expect(newRow).toHaveCount(0, { timeout: 5_000 });
  });

  test("the +Link button is disabled until a key is entered", async ({ page }) => {
    await page.goto("/manual-tests");
    await expect(page.locator("table.tests")).toBeVisible({ timeout: 10_000 });

    await page
      .locator("table.tests tbody tr.test-row", {
        hasText: "Verify PDF export of run report",
      })
      .first()
      .click();

    const modal = page.locator(".modal").last();
    await expect(modal).toBeVisible();
    const addRow = modal.locator(".add-req");
    await addRow.scrollIntoViewIfNeeded();

    const linkBtn = addRow.getByRole("button", { name: /^\+\s*Link$/ });
    await expect(linkBtn).toBeDisabled();

    // Whitespace-only is treated as empty (newReqKey.trim() check).
    await addRow.locator(".req-input-key").fill("    ");
    await expect(linkBtn).toBeDisabled();

    await addRow.locator(".req-input-key").fill("ACME-1");
    await expect(linkBtn).toBeEnabled();
  });
});
