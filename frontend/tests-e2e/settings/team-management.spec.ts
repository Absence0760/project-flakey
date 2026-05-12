import { expect, test } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * /settings — team management.
 *
 * Members list lives in the "Team" card. ADMIN_USER (Acme owner) sees
 * the invite form + per-member role select + remove button. Inviting
 * by email creates a pending invite row with a copyable URL; we don't
 * actually accept the invite (that needs a logged-out browser context
 * + the token URL), but we verify the invite-result panel shows the
 * link.
 */

test.describe("/settings — team management", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test.beforeEach(async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator(".page-title")).toHaveText("Settings", { timeout: 10_000 });
  });

  test("admin sees the team list with at least the owner row", async ({ page }) => {
    // Find the Team card — heading "Team" or class .members-list. The
    // member rows render under .list with avatars + role pills.
    const teamSection = page
      .locator(".card", { has: page.getByPlaceholder("Email address") })
      .first();
    await expect(teamSection).toBeVisible();

    // The admin's own email appears in the list with role "owner".
    await expect(teamSection.locator("body, *", { hasText: ADMIN_USER.email }).first()).toBeVisible();
  });

  test("inviting by email surfaces a copyable invite link", async ({ page }) => {
    const teamSection = page
      .locator(".card", { has: page.getByPlaceholder("Email address") })
      .first();

    const uniqueEmail = `e2e-invite-${Date.now().toString(36)}@example.com`;
    await teamSection.getByPlaceholder("Email address").fill(uniqueEmail);
    await teamSection.getByRole("button", { name: /^Invite$/ }).click();

    await expect(teamSection.getByRole("button", { name: /^(Copied!|Copy)$/ })).toBeVisible({
      timeout: 5_000,
    });
    await expect(teamSection.getByRole("button", { name: /^Dismiss$/ })).toBeVisible();

    await teamSection.getByRole("button", { name: /^Dismiss$/ }).click();
    await expect(teamSection.getByRole("button", { name: /^Dismiss$/ })).toHaveCount(0);
  });

  test("invalid email validation: empty submit produces no invite panel", async ({ page }) => {
    const teamSection = page
      .locator(".card", { has: page.getByPlaceholder("Email address") })
      .first();
    // Click Invite with an empty email — the input has type="email"
    // so HTML5 validation fires and the request never goes out.
    await teamSection.getByRole("button", { name: /^Invite$/ }).click();
    // No invite-result panel appears (no Dismiss button).
    await expect(teamSection.getByRole("button", { name: /^Dismiss$/ })).toHaveCount(0);
  });
});
