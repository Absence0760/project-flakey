import { expect, test } from "@playwright/test";

import { signIn } from "../fixtures/helpers";

/**
 * /login — auth surface for the email-form path.
 *
 * The successful-sign-in flow is in cross-cutting/sign-in-out.spec.ts
 * because it spans /login → /dashboard and is the seam between
 * unauthenticated and authenticated app states. This file holds the
 * /login-only behaviours: failed sign-ins that stay on /login, and
 * (in future rounds) the OAuth-button affordances + reset-password
 * deep-links.
 *
 * Every test in this file uses an empty storage state — the /login
 * surface is only meaningful when unauthenticated.
 */

test.describe("/login", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("rejects an unknown email/password combo and stays on /login", async ({ page }) => {
    await signIn(page, {
      email: "noone@nowhere.test",
      password: "wrong-password",
    });

    // Stay on /login — the form re-renders with an error banner. We
    // don't assert on the error copy (it may shift); the URL
    // behaviour is the security contract — no half-redirect, no
    // auth-state leak, no token written.
    await expect(page).toHaveURL(/\/login/);

    const token = await page.evaluate(() => localStorage.getItem("bt_token"));
    expect(token, "bt_token must not be written on a failed login").toBeNull();
  });
});
