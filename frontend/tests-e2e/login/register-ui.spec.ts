import { expect, test, type Browser, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * /login (register mode) — browser-driven REGISTRATION through the UI form.
 *
 * The pure-API register contract is already covered by auth-flows.spec.ts
 * (POST /auth/register status codes, invite round-trip, 409, 400s). This
 * file is the UI seam those tests don't touch: navigating to the register
 * surface, filling the name/email/password fields through the browser,
 * submitting, and asserting the real post-register behaviour the page
 * drives (sets auth + goto("/dashboard")), plus how validation errors
 * surface in the UI.
 *
 * Dev default is ALLOW_REGISTRATION=off, so a real registration needs a
 * pending invite. We mint one exactly like auth-flows.spec.ts does — an
 * authed admin POSTs /orgs/:id/invites, which returns the raw token in the
 * response body. The backend's register path resolves the pending invite
 * by email, so the unauthenticated browser form (which sends no
 * invite_token) still joins the invited org. We open the form via
 * /login?invite=<token> so the page auto-switches to register mode and the
 * store forwards the token.
 */

const BACKEND = "http://localhost:3000";

/**
 * Collision-resistant unique email. `Date.now()` alone can repeat across
 * parallel Playwright workers that hit the same millisecond, and these
 * addresses feed the UNIQUE constraint on users.email — a duplicate would
 * surface as a spurious 409 and flake the run. The random suffix removes
 * that race (matches the pattern in email-verification-flow.spec.ts /
 * password-reset-flow.spec.ts).
 */
function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

/**
 * Mint a pending invite for `email` into the admin's first org. Spins up a
 * seeded-admin browser context (same pattern as settings.spec.ts) and uses
 * its authenticated request context. The org-invites endpoint returns the
 * raw token straight from the response body — no mailbox interception
 * needed (only org invites return the token over the wire;
 * email-verification/reset tokens don't).
 */
async function createInvite(browser: Browser, email: string): Promise<string> {
  const adminCtx = await browser.newContext({ storageState: ADMIN_USER.storageStatePath });
  try {
    const meRes = await adminCtx.request.get(`${BACKEND}/auth/me`);
    expect(meRes.status()).toBe(200);
    const me = (await meRes.json()) as { user: { orgId: number }; orgs: { id: number }[] };
    const orgId = me.orgs[0]?.id ?? me.user.orgId;

    const inviteRes = await adminCtx.request.post(`${BACKEND}/orgs/${orgId}/invites`, {
      headers: { "Content-Type": "application/json" },
      data: { email, role: "viewer" },
    });
    expect(inviteRes.status(), "admin should be able to create an invite").toBe(201);
    const invite = (await inviteRes.json()) as { invite_token: string };
    expect(invite.invite_token, "invite endpoint returns the raw token").toMatch(/^[a-f0-9]{64}$/);
    return invite.invite_token;
  } finally {
    await adminCtx.close();
  }
}

test.describe("/login — registration via the UI form", () => {
  // Fresh (unauthenticated) session: this is the pre-account surface.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("an invited user fills the form, submits, and lands authenticated on /dashboard", async ({
    page,
    browser,
  }) => {
    test.setTimeout(45_000);

    const email = uniqueEmail("e2e-reg-ui");
    const password = "SecurePass!2024";
    const inviteToken = await createInvite(browser, email);

    // /login?invite=<token> auto-switches the form to register mode and the
    // page forwards the token to POST /auth/register on submit.
    await page.goto(`/login?invite=${inviteToken}`);
    await page.waitForLoadState("networkidle");

    // Register mode shows the name field + the "Create account" submit.
    await expect(page.getByRole("button", { name: /create account/i })).toBeVisible();
    await expect(page.locator("p.invite-banner")).toContainText(/invited to join/i);

    // Fill the form through the browser.
    await page.locator('input[type="text"]').fill("E2E Reg UI User");
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);

    // Submit and wait on the real navigation the page drives.
    await Promise.all([
      page.waitForURL(/\/dashboard/),
      page.locator('form button[type="submit"]').click(),
    ]);

    // The register store set auth before navigating — the dashboard renders
    // its ready signal once the route's onMount fetch settles.
    await expect(page.locator('.page[data-ready="true"]')).toBeVisible();

    // Auth is actually established (token in localStorage, valid against the API).
    const token = await getToken(page);
    expect(token, "register should have stored a JWT in localStorage").toBeTruthy();
    const meRes = await page.request.get(`${BACKEND}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(meRes.status()).toBe(200);
    expect(((await meRes.json()) as { user: { email: string } }).user.email).toBe(email);
  });

  test("a weak password is rejected and the backend error surfaces in the UI", async ({
    page,
    browser,
  }) => {
    test.setTimeout(45_000);

    const email = uniqueEmail("e2e-reg-weak");
    const inviteToken = await createInvite(browser, email);

    await page.goto(`/login?invite=${inviteToken}`);
    await page.waitForLoadState("networkidle");

    await page.locator('input[type="text"]').fill("Weak PW User");
    await page.locator('input[type="email"]').fill(email);
    // < 8 chars: passes the browser's `required` check but the backend
    // rejects it with 400 "at least 8 characters", which the page surfaces.
    await page.locator('input[type="password"]').fill("short");
    await page.locator('form button[type="submit"]').click();

    // The store throws the backend error message; handleSubmit puts it in p.error.
    await expect(page.locator("p.error")).toContainText(/8 characters/i);
    // Still on /login — no navigation happened.
    await expect(page).toHaveURL(/\/login/);
    // No auth was established.
    expect(await getToken(page)).toBe("");
  });

  test("an invalid email format is blocked by the form before any request fires", async ({
    page,
  }) => {
    test.setTimeout(30_000);

    // No invite needed — native constraint validation on the type=email
    // input blocks submission client-side, so /auth/register is never hit.
    await page.goto(`/login?mode=register`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: /create account/i })).toBeVisible();

    const emailInput = page.locator('input[type="email"]');
    await emailInput.fill("not-an-email");
    await page.locator('input[type="password"]').fill("SecurePass!2024");

    // Fail the test loudly if the browser actually lets this POST through.
    let registerHit = false;
    await page.route("**/auth/register", (route) => {
      registerHit = true;
      return route.abort();
    });

    await page.locator('form button[type="submit"]').click();

    // The browser's constraint validation reports the email field invalid
    // and prevents the form's submit handler from running.
    const valid = await emailInput.evaluate(
      (el) => (el as HTMLInputElement).validity.valid,
    );
    expect(valid, "an invalid email format should fail HTML5 validity").toBe(false);
    expect(registerHit, "/auth/register must not be called with an invalid email").toBe(false);
    await expect(page).toHaveURL(/\/login/);
  });

  test("registering an already-used email surfaces the 409 conflict in the UI", async ({
    page,
    browser,
  }) => {
    test.setTimeout(60_000);

    const email = uniqueEmail("e2e-reg-dupe");
    const password = "SecurePass!2024";

    // First registration via the UI succeeds and lands on /dashboard.
    const firstInvite = await createInvite(browser, email);
    await page.goto(`/login?invite=${firstInvite}`);
    await page.waitForLoadState("networkidle");
    await page.locator('input[type="text"]').fill("First Signup");
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await Promise.all([
      page.waitForURL(/\/dashboard/),
      page.locator('form button[type="submit"]').click(),
    ]);
    await expect(page.locator('.page[data-ready="true"]')).toBeVisible();

    // Clear the session so the second attempt is a clean pre-account submit.
    await page.evaluate(() => localStorage.clear());

    // Second invite for the SAME email, register again → backend 409,
    // surfaced verbatim in the UI error container.
    const secondInvite = await createInvite(browser, email);
    await page.goto(`/login?invite=${secondInvite}`);
    await page.waitForLoadState("networkidle");
    await page.locator('input[type="text"]').fill("Second Signup");
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.locator('form button[type="submit"]').click();

    await expect(page.locator("p.error")).toContainText("Email already registered");
    await expect(page).toHaveURL(/\/login/);
  });
});
