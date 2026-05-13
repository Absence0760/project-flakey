import { expect, test } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * Public landing page at /.
 *
 * Two distinct contracts:
 *
 *   1. UNAUTHENTICATED visitors see marketing copy at /. No redirect.
 *      The page is the org's funnel from "saw the README" to "signed
 *      in" — it must NOT hide behind an auth gate.
 *   2. AUTHENTICATED visitors who happen to land on / get redirected
 *      to /dashboard. This covers the "bookmarked the root" and
 *      "clicked the logo from a logged-in session" cases.
 *
 * Each test runs with an explicit storageState so the auth/no-auth
 * matrix is exhaustive. The default storageState in playwright.config
 * is admin (authenticated) — we override per-test.
 */

test.describe("/ landing page — unauthenticated", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("renders the product hero + compare table + footer for unauthenticated visitors (no redirect)", async ({ page }) => {
    await page.goto("/");

    // No /login or /dashboard redirect should fire — visitor stays on `/`.
    await expect(page).toHaveURL(/\/$/);

    // Hero copy is the funnel contract — the headline must mention
    // the positioning ("self-hosted" + "CI-agnostic") because that's
    // what the docs / READMEs promise.
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/self-hosted/i);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/CI-agnostic/i);

    // Compare table is the second-half hook — must render and
    // include the four competitor columns we promised in the audit
    // fix conversation.
    await expect(page.getByRole("heading", { name: /How Flakey compares/i })).toBeVisible();
    for (const product of ["Flakey", "Cypress Cloud", "BrowserStack", "Currents.dev", "TestRail"]) {
      await expect(page.locator("th", { hasText: product })).toBeVisible();
    }

    // Primary CTA points at /login. We use getByRole to dodge the
    // duplicate "Sign in →" link inside the topnav.
    const primaryCta = page.getByRole("link", { name: /^Sign in$/i });
    await expect(primaryCta.first()).toBeVisible();
    await expect(primaryCta.first()).toHaveAttribute("href", "/login");
  });

  test("clicking 'Sign in' navigates to /login (no auth state was set)", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /^Sign in$/i }).first().click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("clicking 'Create an account' lands on /login?mode=register so the form opens in register mode", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /create an account/i }).first().click();
    await expect(page).toHaveURL(/\/login\?mode=register/);
    // The register form has a Name field — the login form doesn't.
    // Asserting the field is the cleanest "we're in register mode" check.
    await expect(page.locator('input[type="text"]')).toBeVisible();
  });

  test("compare table flags Flakey as 'yes' on the four claims that are core to the positioning", async ({ page }) => {
    await page.goto("/");
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
      // The Flakey column is the first product column (2nd <td>).
      const flakeyCell = rowEl.locator("td.flakey-cell").first();
      const mark = flakeyCell.locator(".cell-mark");
      await expect(mark).toHaveAttribute("aria-label", "yes");
    }
  });
});

test.describe("/ landing page — authenticated", () => {
  // Re-attach the admin storage state so this page's onMount sees a
  // valid bt_token + bt_user and the redirect path fires.
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("authenticated visitor at / is redirected to /dashboard", async ({ page }) => {
    await page.goto("/");
    // The redirect fires inside onMount after restoreAuth() reads
    // localStorage. Playwright's default `goto` waits for load; we
    // need to wait for the client-side redirect to settle.
    await expect(page).toHaveURL(/\/dashboard/);
    // Confirm we're actually inside the (app) layout, not still on
    // the landing copy.
    await expect(page.locator(".sidebar")).toBeVisible();
  });
});
