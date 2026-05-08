import { expect, test } from "@playwright/test";

import { signIn } from "./fixtures/helpers";
import { ADMIN_USER } from "./fixtures/users";

/**
 * /login — auth surface for the email-form path.
 *
 * This file holds the /login-only behaviours: the failed-sign-in
 * error path, and (in future rounds) the forgot-password and
 * sign-up affordances. The successful sign-in → /dashboard flow
 * is also exercised here for now because there's only one spec
 * file; once a cross-cutting/sign-in-out.spec.ts exists, move the
 * happy-path case there and keep this file focused on the form's
 * own behaviour.
 *
 * Every test in this file uses an empty storage state — the
 * /login surface is only reachable from an unauthenticated
 * context. globalSetup writes admin/demo states for other specs;
 * we explicitly opt out here.
 */

test.describe("/login", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("seeded admin signs in → redirects to /dashboard with bt_token in localStorage", async ({
    page,
  }) => {
    await signIn(page, ADMIN_USER);

    // The success handler in src/routes/login/+page.svelte calls
    // goto("/dashboard"); the URL transition is the contract.
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });

    // The auth singleton in src/lib/auth.ts persists the JWT under
    // the `bt_` prefix on every successful login. A regression that
    // forgets to write the token would still pass the URL assertion
    // (initial /dashboard render works while in-memory state is
    // populated) but every subsequent reload would bounce back to
    // /login. Asserting on the localStorage write catches that.
    const token = await page.evaluate(() => localStorage.getItem("bt_token"));
    expect(token, "bt_token should be set after a successful login").toBeTruthy();
  });

  test("rejects an unknown email/password combo and stays on /login", async ({ page }) => {
    await signIn(page, {
      email: "noone@nowhere.test",
      password: "wrong-password",
    });

    // Stay on /login — the form re-renders with an error banner.
    // We don't assert the error copy; it may shift, and the URL
    // behaviour is the security contract (no auth-state leak,
    // no half-redirect, no token written).
    await expect(page).toHaveURL(/\/login/);

    const token = await page.evaluate(() => localStorage.getItem("bt_token"));
    expect(token, "bt_token must not be written on a failed login").toBeNull();
  });
});
