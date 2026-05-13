import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * /releases — creating a release via the inline form actually persists
 * + a deletion flow.
 *
 * The existing releases.spec.ts covers the inline create form's UX
 * (form opens, fills, closes, card surfaces). This spec drives the
 * full lifecycle: create via UI → confirm visible → delete via the
 * DELETE /releases/:id endpoint (the path CI integrations and the
 * MCP server use; the dashboard doesn't currently expose a UI delete
 * CTA on the detail page) → confirm the card is gone from the list.
 *
 * Why test the API delete path here rather than skipping when the UI
 * delete is missing: customers' release-cleanup scripts, the MCP
 * mutation tools, and the eventual UI delete button all reduce to
 * DELETE /releases/:id, so the through-the-API delete is what the
 * lifecycle actually depends on.
 */

async function createReleaseViaForm(page: Page): Promise<string> {
  await page.goto("/releases");
  await expect(page.locator(".release-grid").first()).toBeVisible({ timeout: 10_000 });

  // The "+ New release" button opens a modal overlay (the earlier
  // inline .create-card design was replaced in the UI polish pass).
  await page.getByRole("button", { name: /New release/ }).click();
  const modal = page.locator(".modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });

  const version = `e2e-create-${Date.now().toString(36)}`;
  await modal.locator('input[placeholder*="v1.2.0"]').fill(version);
  await modal.getByRole("button", { name: /^Create release$/ }).click();
  await expect(modal).toBeHidden({ timeout: 5_000 });
  return version;
}

test.describe("releases — create-then-delete lifecycle", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("admin creates a release via the UI form, then DELETE /releases/:id removes it from the listing", async ({
    page,
  }) => {
    const version = await createReleaseViaForm(page);

    // Releases grid paginates at 50; the just-created card may not
    // be on page 1 in a populated dev DB — filter via search.
    await page.getByPlaceholder("Search version or name…").fill(version);
    const card = page.locator(".release-card", {
      has: page.locator(".version", { hasText: version }),
    }).first();
    await expect(card).toBeVisible({ timeout: 5_000 });
    await card.click();

    // Land on the detail page so we can read the release's id from the URL.
    await expect(page.getByRole("heading", { name: version })).toBeVisible({ timeout: 10_000 });
    const detailUrl = page.url();
    const idMatch = detailUrl.match(/\/releases\/(\d+)/);
    expect(idMatch, `release-detail URL should match /releases/<id>; got ${detailUrl}`).not.toBeNull();
    const releaseId = Number(idMatch![1]);

    const token = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
    const delRes = await page.request.delete(`http://localhost:3000/releases/${releaseId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delRes.status(), "admin should be allowed to DELETE /releases/:id").toBeLessThan(300);

    // Re-load the listing — the card we created is gone.
    await page.goto("/releases");
    await expect(
      page.locator(".release-card", {
        has: page.locator(".version", { hasText: version }),
      }),
      "the deleted release must NOT appear on the /releases listing",
    ).toHaveCount(0, { timeout: 5_000 });

    // Direct GET /releases/:id is now a 404.
    const detailAfter = await page.request.get(`http://localhost:3000/releases/${releaseId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(detailAfter.status(), "GET /releases/:id should 404 after delete").toBe(404);
  });
});
