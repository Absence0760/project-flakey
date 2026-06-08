import { expect, test } from "@playwright/test";

const BACKEND = "http://localhost:3000";

/**
 * /login — the SSO sign-in affordance.
 *
 * Closes the gap flagged as deferred in login/login.spec.ts ("the
 * OAuth-button affordances"). The /login page renders a
 * `data-test="sso-entry"` button ("Sign in with SSO") that toggles the
 * form into SSO mode: an org-slug field plus a `data-test="sso-continue"`
 * submit. Submitting calls `startSso()`, which does a full-page
 * `window.location.href` redirect to the backend's
 * `${API_URL}/auth/sso/<slug>/start` endpoint (the OIDC/SAML handoff).
 *
 * The redirect is a full top-level navigation, so it can't be observed
 * with request stubbing of an XHR — but it IS a real browser navigation
 * request, which we intercept with `page.route()`. Intercepting lets us
 * assert the exact target URL the browser tried to load (the real
 * "redirect fired with the right target" signal) without depending on a
 * configured IdP or the flag-gated FLAKEY_SSO_ENABLED backend (the
 * `/start` endpoint fail-closes with 404 when SSO isn't configured —
 * which is the default for every seeded org). We fulfill the
 * intercepted navigation with a stub so the test never leaves /login for
 * a real IdP.
 *
 * Every test uses an empty storage state — the /login surface is only
 * meaningful when unauthenticated.
 */

test.describe("/login — SSO affordance", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("renders the SSO entry button and reveals the org-slug form on click", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    // The affordance is present on the default (login) view.
    const ssoEntry = page.locator('button[data-test="sso-entry"]');
    await expect(ssoEntry).toBeVisible();
    await expect(ssoEntry).toHaveText("Sign in with SSO");

    // Clicking it toggles into SSO mode: org-slug input + continue button.
    await ssoEntry.click();

    const orgSlug = page.locator('input[autocomplete="organization"]');
    await expect(orgSlug).toBeVisible();
    const continueBtn = page.locator('button[data-test="sso-continue"]');
    await expect(continueBtn).toBeVisible();
    await expect(continueBtn).toHaveText("Continue with SSO");

    // The password field from the email-login form is gone in SSO mode.
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  });

  test("initiates the SSO redirect to the backend start endpoint with the entered org slug", async ({ page }) => {
    // Intercept the full-page navigation the browser makes when
    // startSso() sets window.location.href, and short-circuit it so we
    // never hit a real IdP or the fail-closed /start 404. Fulfilling with
    // a benign page resolves the navigation without bouncing externally.
    await page.route(`${BACKEND}/auth/sso/**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<html><body>sso-start-intercepted</body></html>",
      });
    });

    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    await page.locator('button[data-test="sso-entry"]').click();

    // The app lowercases + trims the slug before building the URL, so we
    // feed mixed case / whitespace and assert the normalized form lands
    // in the redirect target.
    await page.locator('input[autocomplete="organization"]').fill("  Acme  ");

    // Submitting fires the full-page navigation. Wait on the intercepted
    // request — a real signal, not a sleep — and read the target URL off
    // the awaited request itself, so the assertion never races the
    // route handler.
    const [request] = await Promise.all([
      page.waitForRequest(`${BACKEND}/auth/sso/**`),
      page.locator('button[data-test="sso-continue"]').click(),
    ]);

    expect(request.url()).toBe(`${BACKEND}/auth/sso/acme/start`);
  });

  test("blocks the redirect and shows a validation error when no org slug is entered", async ({ page }) => {
    // If startSso() ever fired with an empty slug it would be a bug —
    // assert the navigation is NOT made.
    let redirectFired = false;
    await page.route(`${BACKEND}/auth/sso/**`, async (route) => {
      redirectFired = true;
      await route.fulfill({ status: 200, contentType: "text/html", body: "" });
    });

    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    await page.locator('button[data-test="sso-entry"]').click();

    // The org-slug input is `required`, so a native form submit would be
    // blocked by the browser. Bypass the constraint to exercise the app's
    // own `startSso()` empty-slug guard (the "" → error branch) rather
    // than the browser's required-field UI.
    await page.locator('input[autocomplete="organization"]').evaluate((el) => {
      (el as HTMLInputElement).removeAttribute("required");
    });

    await page.locator('button[data-test="sso-continue"]').click();

    // App-side validation copy from startSso().
    await expect(page.locator("p.error")).toHaveText(
      "Enter your organization's identifier",
    );

    // Still on the SSO form, no navigation attempted.
    await expect(page.locator('button[data-test="sso-continue"]')).toBeVisible();
    expect(redirectFired, "no SSO redirect should fire without an org slug").toBe(false);
  });
});
