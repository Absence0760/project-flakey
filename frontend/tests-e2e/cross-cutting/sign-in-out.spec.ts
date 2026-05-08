import { expect, test } from "@playwright/test";

import { signIn, signOut } from "../fixtures/helpers";
import { ADMIN_USER } from "../fixtures/users";

/**
 * Auth lifecycle — the seam between unauthenticated and
 * authenticated app states. Spans /login → /dashboard and the
 * (app) layout's restoreAuth + logout paths.
 *
 * This spec runs from a clean storage state on purpose; we're
 * testing the lifecycle, not the steady-state.
 */

test.describe("auth lifecycle", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sign in → /dashboard renders the (app) shell with the user's email + org", async ({
    page,
  }) => {
    await signIn(page, ADMIN_USER);

    // The form's success handler navigates to /dashboard.
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });

    // The (app) layout pulls user + orgs after restoreAuth. Failing to
    // wire either dropped sidebar identity for the user, which is the
    // observable contract of "I'm signed in".
    const sidebar = page.locator("aside.sidebar");
    await expect(sidebar.locator(".user-email")).toHaveText(ADMIN_USER.email);
    await expect(sidebar.locator(".user-name")).toHaveText(ADMIN_USER.name);

    // Org name is loaded asynchronously after the layout's loadOrgs()
    // resolves. Acme Corp is admin's seeded org.
    await expect(sidebar.locator(".org-name")).toHaveText("Acme Corp");
  });

  test("auth survives a page reload (bt_token + restoreAuth round-trip)", async ({ page }) => {
    await signIn(page, ADMIN_USER);
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });

    // Reload picks up bt_token from localStorage via the auth
    // singleton's restoreAuth(). A regression that forgets to write
    // the token, or that doesn't read the right key (the rebrand
    // moved flakey_* → bt_*), would bounce us back to /login.
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.locator("aside.sidebar .user-email")).toHaveText(ADMIN_USER.email);
  });

  test("sign out clears bt_token and redirects to /login", async ({ page }) => {
    await signIn(page, ADMIN_USER);
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });

    await signOut(page);

    // Storage cleared — auth singleton's logout() resets state and
    // unsets the localStorage entries.
    const tokens = await page.evaluate(() => ({
      token: localStorage.getItem("bt_token"),
      user: localStorage.getItem("bt_user"),
      refresh: localStorage.getItem("bt_refresh"),
    }));
    expect(tokens.token, "bt_token should be cleared on logout").toBeNull();
    expect(tokens.user, "bt_user should be cleared on logout").toBeNull();
    expect(tokens.refresh, "bt_refresh should be cleared on logout").toBeNull();
  });
});
