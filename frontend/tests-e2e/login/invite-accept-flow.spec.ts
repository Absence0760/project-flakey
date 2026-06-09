import { expect, test, type Browser, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * /invite/[token] — the ACCEPT side of the invite flow.
 *
 * Existing specs cover SENDING an invite (settings.spec.ts) and registering
 * THROUGH an invite link (register-ui.spec.ts: /login?invite=<token> →
 * POST /auth/register, which resolves the pending invite by email). What
 * neither touches is the dedicated accept page at
 * src/routes/invite/[token]/+page.svelte and the `acceptInvite(token)` store
 * call it drives: an ALREADY-AUTHENTICATED user opening an invite link, which
 * POSTs /orgs/invites/:token/accept and lands them inside the org with a
 * fresh org-scoped JWT.
 *
 * The page's contract (read from +page.svelte):
 *   - not logged in            → goto(`/login?invite=<token>`)
 *   - logged in + valid token  → acceptInvite() → "You've joined <org>!" +
 *                                a "Go to Dashboard" button
 *   - logged in + bad token    → the backend 404 surfaces as the error card
 *
 * To reach the authenticated branch we first need a real signed-in session
 * whose email matches the invite (the accept route 403s on an email
 * mismatch). We mint that session the same way register-ui.spec.ts does:
 * admin mints an invite for a fresh unique email, the invitee registers
 * through the UI (landing authenticated on /dashboard). Then a SECOND invite
 * for that same email is minted, and THAT is the token we accept through the
 * /invite/[token] page as the logged-in user.
 */

const BACKEND = "http://localhost:3000";

/**
 * Collision-resistant unique email. `Date.now()` alone can repeat across
 * parallel workers landing in the same millisecond; these addresses feed the
 * UNIQUE constraint on users.email, so a collision would surface as a
 * spurious 409 and flake the run. The random suffix removes that race
 * (matches register-ui.spec.ts / email-verification-flow.spec.ts).
 */
function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

/**
 * Mint a pending invite for `email` into the admin's first org (Acme). Uses a
 * seeded-admin browser context's authenticated request fixture; the
 * org-invites endpoint returns the raw token in the response body (only org
 * invites do — email-verification/reset tokens stay server-side). Returns the
 * token plus the org's display name so the spec can assert the accept card
 * names the org the user joined.
 */
async function createInvite(
  browser: Browser,
  email: string,
): Promise<{ token: string; orgName: string }> {
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
    const invite = (await inviteRes.json()) as { invite_token: string; org_name: string };
    expect(invite.invite_token, "invite endpoint returns the raw token").toMatch(/^[a-f0-9]{64}$/);
    return { token: invite.invite_token, orgName: invite.org_name };
  } finally {
    await adminCtx.close();
  }
}

/**
 * Register a fresh invited user through the UI form, leaving the page
 * authenticated on /dashboard. Mirrors register-ui.spec.ts so the
 * authenticated session is established the real way (no token injection).
 */
async function registerViaInvite(
  page: Page,
  browser: Browser,
  email: string,
  password: string,
): Promise<void> {
  const { token } = await createInvite(browser, email);
  await page.goto(`/login?invite=${token}`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: /create account/i })).toBeVisible();

  await page.locator('input[type="text"]').fill("Invite Accept User");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);

  await Promise.all([
    page.waitForURL(/\/dashboard/),
    page.locator('form button[type="submit"]').click(),
  ]);
  await expect(page.locator('.page[data-ready="true"]')).toBeVisible();
}

test.describe("/invite/[token] — accepting an invite", () => {
  // Pre-account / fresh-session surface: start unauthenticated and establish
  // the session inside the test via the real register form.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a signed-in user opens a valid invite link, accepts, and lands authenticated in the org", async ({
    page,
    browser,
  }) => {
    test.setTimeout(60_000);

    const email = uniqueEmail("e2e-invite-accept");
    const password = "SecurePass!2024";

    // ── Establish a real authenticated session for this email.
    await registerViaInvite(page, browser, email, password);
    const sessionToken = await getToken(page);
    expect(sessionToken, "register should have stored a JWT").toBeTruthy();

    // ── Mint a SECOND invite for the SAME email — this is the token the
    //    accept page will POST to /orgs/invites/:token/accept. (Accept is
    //    idempotent via ON CONFLICT DO NOTHING, so re-joining is a clean
    //    success that still re-issues an org-scoped JWT + returns org_name.)
    const { token: acceptToken, orgName } = await createInvite(browser, email);

    // ── Open the dedicated accept page as the logged-in user. The page's
    //    $effect sees isLoggedIn() === true and calls acceptInvite(token)
    //    directly (no /login bounce).
    await page.goto(`/invite/${acceptToken}`);

    // Wait on the real success signal the page renders once acceptInvite
    // resolves — the "You've joined <org>!" message naming the joined org.
    const success = page.locator("p.message.success");
    await expect(success).toBeVisible();
    await expect(success).toContainText(/you've joined/i);
    await expect(success).toContainText(orgName);
    expect(orgName).toBe("Acme Corp");

    // acceptInvite() called setAuth() with the token the accept endpoint
    // returned — localStorage now holds an org-scoped JWT for the invited org.
    // (We don't assert it DIFFERS from the register-session token: the register
    // flow already resolved this same pending invite by email and org-scoped
    // the session, so the idempotent re-accept can mint claims identical to the
    // register token — and an HS256 JWT over identical claims minted in the
    // same `iat` second is byte-identical. That collision is timing-dependent,
    // not a behavioural signal; asserting on it would be a race. The durable
    // contract — a valid token for the invited email + accepted org — is
    // verified against /auth/me below.)
    const acceptedToken = await getToken(page);
    expect(acceptedToken, "accept should have stored a JWT").toBeTruthy();

    // ── The page offers "Go to Dashboard"; clicking it lands the user in the
    //    authenticated app, scoped to the org they accepted into.
    await Promise.all([
      page.waitForURL(/\/dashboard/),
      page.getByRole("button", { name: /go to dashboard/i }).click(),
    ]);
    await expect(page.locator('.page[data-ready="true"]')).toBeVisible();

    // The sidebar org switcher shows the active org's name — proof the
    // session is scoped to the org the invite was for.
    await expect(page.locator(".org-name")).toHaveText(orgName);

    // And the JWT is genuinely valid against the API for this email.
    const meRes = await page.request.get(`${BACKEND}/auth/me`, {
      headers: { Authorization: `Bearer ${acceptedToken}` },
    });
    expect(meRes.status()).toBe(200);
    const me = (await meRes.json()) as { user: { email: string; orgId: number }; orgs: { id: number; name: string }[] };
    expect(me.user.email).toBe(email);
    expect(
      me.orgs.some((o) => o.id === me.user.orgId && o.name === orgName),
      "the accepted org should be the active org",
    ).toBe(true);
  });

  test("an unauthenticated visitor is bounced to /login with the invite token preserved", async ({
    page,
    browser,
  }) => {
    test.setTimeout(45_000);

    // A real, still-pending invite — but no session. The accept page's
    // $effect sees isLoggedIn() === false and redirects to
    // /login?invite=<token> so the visitor can register/sign-in first.
    const email = uniqueEmail("e2e-invite-bounce");
    const { token } = await createInvite(browser, email);

    await page.goto(`/invite/${token}`);

    await page.waitForURL(`**/login?invite=${token}`);
    // The login page picks the token up, switches to register mode, and shows
    // the invite banner — the seam that hands the visitor off to register-ui.
    await expect(page.getByRole("button", { name: /create account/i })).toBeVisible();
    await expect(page.locator("p.invite-banner")).toContainText(/invited to join/i);
  });

  test("a signed-in user opening a garbage token sees the error card", async ({
    page,
    browser,
  }) => {
    test.setTimeout(45_000);

    // Establish a real session (any valid invited user) so the accept page
    // takes the acceptInvite() branch rather than the /login bounce — then
    // feed it a token that doesn't exist. The backend 404s ("Invite not found
    // or expired") and the page surfaces it in the error card.
    const email = uniqueEmail("e2e-invite-bad");
    await registerViaInvite(page, browser, email, "SecurePass!2024");

    const bogus = `deadbeef${Date.now().toString(16)}${"0".repeat(48)}`.slice(0, 64);
    await page.goto(`/invite/${bogus}`);

    const errorCard = page.locator("p.message.error");
    await expect(errorCard).toBeVisible();
    await expect(errorCard).toContainText(/not found|expired/i);
    // No success card rendered.
    await expect(page.locator("p.message.success")).toHaveCount(0);
  });
});
