import { expect, test } from "../fixtures/test";


/**
 * Two routes, two contracts:
 *
 *   1. `/` — auth-aware REDIRECT-ONLY route. Authenticated → /dashboard,
 *      unauthenticated → /login. No marketing copy. This is what
 *      self-hosters want their internal URL to do.
 *
 *   2. `/welcome` — public marketing landing page. Always renders; never
 *      redirects. Authenticated visitors who hit /welcome explicitly
 *      stay on /welcome — they asked for the marketing page. The hosted
 *      SaaS at flakey.io can either redirect the public root to /welcome
 *      at the CDN layer or link to /welcome from external marketing.
 *
 * Splitting the two means every protected route (including /) gates on
 * auth, and the auth-walls.spec contract — "every route under (app)
 * redirects to /login when unauthenticated" — holds for `/` too.
 */

test.describe("/ — auth-aware redirect", () => {
  test.describe("unauthenticated", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("unauthenticated visit to / redirects to /login (the self-host default)", async ({ page }) => {
      await page.goto("/");
      await expect(page).toHaveURL(/\/login/);
    });
  });

  test.describe("authenticated", () => {

    test("authenticated visit to / redirects to /dashboard", async ({ page }) => {
      await page.goto("/");
      await expect(page).toHaveURL(/\/dashboard/);
      // Confirm we're inside the (app) layout, not still on the
      // redirect-only stub.
      await expect(page.locator(".sidebar")).toBeVisible();
    });
  });
});

test.describe("/welcome — public marketing landing page", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("renders the product hero + compare table + footer for unauthenticated visitors (no redirect)", async ({ page }) => {
    await page.goto("/welcome");

    // The visitor stays on /welcome — no redirect to /login or /dashboard.
    await expect(page).toHaveURL(/\/welcome/);

    // Hero copy is the funnel contract — the headline must mention
    // the positioning ("self-hosted" + "CI-agnostic") because that's
    // what the docs / READMEs promise.
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/self-hosted/i);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/CI-agnostic/i);

    // Compare table is the second-half hook — must render and
    // include the four competitor columns we promised.
    await expect(page.getByRole("heading", { name: /How Flakey compares/i })).toBeVisible();
    for (const product of ["Flakey", "Cypress Cloud", "BrowserStack", "Currents.dev", "TestRail"]) {
      await expect(page.locator("th", { hasText: product })).toBeVisible();
    }

    // Primary CTA points at /login.
    const primaryCta = page.getByRole("link", { name: /^Sign in$/i });
    await expect(primaryCta.first()).toBeVisible();
    await expect(primaryCta.first()).toHaveAttribute("href", "/login");
  });

  test("clicking 'Sign in' navigates to /login (no auth state was set)", async ({ page }) => {
    await page.goto("/welcome");
    await page.getByRole("link", { name: /^Sign in$/i }).first().click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("'Self-host' CTA links out to the GitHub README anchor (no client-side nav)", async ({ page }) => {
    // The Self-host CTA points at the upstream repo's README#self-host
    // section. We don't click it (target=_blank + external) — just
    // assert the link is present and well-formed so a future copy
    // edit that drops it surfaces in CI.
    await page.goto("/welcome");
    const cta = page.getByRole("link", { name: /^Self-host/ }).first();
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", /github\.com.+#self-host/);
    await expect(cta).toHaveAttribute("target", "_blank");
    await expect(cta).toHaveAttribute("rel", /noopener/);
  });

  test("clicking 'Create an account' lands on /login?mode=register so the form opens in register mode", async ({ page }) => {
    await page.goto("/welcome");
    await page.getByRole("link", { name: /create an account/i }).first().click();
    await expect(page).toHaveURL(/\/login\?mode=register/);
    // The register form has a Name field — the login form doesn't.
    // Asserting the field is the cleanest "we're in register mode" check.
    await expect(page.locator('input[type="text"]')).toBeVisible();
  });

  test("compare table flags Flakey as 'yes' on the four claims that are core to the positioning", async ({ page }) => {
    await page.goto("/welcome");
    await expect(page.getByRole("heading", { name: /How Flakey compares/i })).toBeVisible();

    // For each must-win row, the Flakey cell should carry the 'yes'
    // class (rendered as ✓). The cell-mark span has aria-label="yes".
    for (const row of [
      "Self-hosted",
      "CI-agnostic",
      "Manual + automated in one place",
      "Open source",
    ]) {
      const rowEl = page.locator("tr", { hasText: row });
      const flakeyCell = rowEl.locator("td.flakey-cell").first();
      const mark = flakeyCell.locator(".cell-mark");
      await expect(mark).toHaveAttribute("aria-label", "yes");
    }
  });
});

test.describe("/welcome — registration posture adapts to backend", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("when /auth/registration-status returns {open: true}, the 'Create an account' CTA is visible (default dev posture)", async ({ page }) => {
    // The local dev backend has ALLOW_REGISTRATION=true so the
    // endpoint returns open:true. Welcome page hero shows the
    // Create-an-account CTA, no invite-only note.
    await page.goto("/welcome");
    await expect(page.getByRole("link", { name: /create an account/i }).first()).toBeVisible();
    await expect(page.locator('[data-test="invite-only-note"]')).toHaveCount(0);
  });

  test("when /auth/registration-status returns {open: false}, the CTA is hidden and the invite-only note renders", async ({ page }) => {
    // Mock the registration-status endpoint so this test exercises
    // the closed branch without needing a second backend process.
    await page.route("**/auth/registration-status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ open: false }),
      });
    });

    await page.goto("/welcome");

    await expect(page.locator('[data-test="invite-only-note"]')).toBeVisible();
    await expect(page.getByRole("link", { name: /^Create an account$/ })).toHaveCount(0);

    // The "Sign in" CTA must still be visible — invite-only doesn't
    // mean the page becomes useless to existing users.
    await expect(page.getByRole("link", { name: /^Sign in$/i }).first()).toBeVisible();
  });

  test("login page in register mode shows the invite-only banner when registration is closed", async ({ page }) => {
    await page.route("**/auth/registration-status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ open: false }),
      });
    });

    await page.goto("/login?mode=register");

    await expect(page.locator('[data-test="invite-only-banner"]')).toBeVisible({ timeout: 5_000 });
    // The form is still rendered — the email-match flow still works,
    // so we don't disable the submit button.
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });
});
