import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * Registration gate — BROWSER coverage of the production posture
 * (REQUIRE_EMAIL_VERIFICATION=true).
 *
 * The HTTP contract (register withholds the session, login 403s until the
 * emailed link is clicked) is already proven in CI by the backend smoke test
 * register_verification_gate.smoke.test.ts, which spawns its own flag-on
 * backend. This spec covers the layer that smoke can't: the SvelteKit UI the
 * user actually sees — the "Check your email" panel instead of a dashboard
 * redirect, no token in localStorage, the same panel on a pre-verify login,
 * and the real verify→login completion.
 *
 * It runs against a backend started with REQUIRE_EMAIL_VERIFICATION=true (the
 * verify-required CI job / `pnpm dev:backend` with the flag locally), via its
 * own playwright.verify.config.ts — the main e2e run is the flag-OFF default
 * posture and ignores this directory. Mirrors the SSO app-e2e split.
 *
 * No sleeps: every wait is on a real signal — navigation, the rendered panel,
 * Mailpit message arrival (expect.poll), and the verify page's success state.
 */

const BACKEND = "http://localhost:3000";
// Mailpit web API. Pin to 127.0.0.1 in CI — `localhost` resolves to ::1 first
// on the runner but Docker publishes Mailpit on IPv4 only.
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

/** Collision-resistant unique email (parallel-worker + same-ms safe). */
function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

/**
 * Mint a pending invite for `email` into the seeded admin's first org, using
 * the admin's saved storage state (globalSetup signs the admin in — seeded
 * users are email_verified=true, so login works even with the gate on). The
 * org-invites endpoint returns the raw token in the response body.
 */
async function createInvite(browser: Browser, email: string): Promise<string> {
  const adminCtx = await browser.newContext({ storageState: ADMIN_USER.storageStatePath });
  try {
    const meRes = await adminCtx.request.get(`${BACKEND}/auth/me`);
    expect(meRes.status(), "seeded admin should be authenticated").toBe(200);
    const me = (await meRes.json()) as { user: { orgId: number }; orgs: { id: number }[] };
    const orgId = me.orgs[0]?.id ?? me.user.orgId;

    const inviteRes = await adminCtx.request.post(`${BACKEND}/orgs/${orgId}/invites`, {
      headers: { "Content-Type": "application/json" },
      data: { email, role: "viewer" },
    });
    expect(inviteRes.status(), "admin should be able to create an invite").toBe(201);
    const invite = (await inviteRes.json()) as { invite_token: string };
    expect(invite.invite_token).toMatch(/^[a-f0-9]{64}$/);
    return invite.invite_token;
  } finally {
    await adminCtx.close();
  }
}

/** Poll Mailpit for the verification token emailed to `email`. */
async function fetchVerificationToken(request: APIRequestContext, email: string): Promise<string> {
  let token = "";
  await expect
    .poll(
      async () => {
        const searchRes = await request.get(
          `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email} subject:"Verify your email"`)}&limit=20`,
        );
        if (!searchRes.ok()) return "";
        const { messages } = (await searchRes.json()) as { messages: { ID: string }[] };
        for (const msg of messages) {
          const msgRes = await request.get(`${MAILPIT}/api/v1/message/${msg.ID}`);
          if (!msgRes.ok()) continue;
          const body = (await msgRes.json()) as { Text: string; HTML: string };
          const m = `${body.Text}\n${body.HTML}`.match(/\/verify-email\/([a-f0-9]{64})/);
          if (m) {
            token = m[1];
            return token;
          }
        }
        return "";
      },
      { message: `verification email for ${email} should arrive in Mailpit`, timeout: 15_000 },
    )
    .not.toBe("");
  return token;
}

test.describe("registration gate — REQUIRE_EMAIL_VERIFICATION=true (browser)", () => {
  // Fresh, unauthenticated session: this is the pre-account surface.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("invited register withholds the session and shows 'check your email'; login is blocked until the link is clicked, then succeeds", async ({
    page,
    browser,
  }) => {
    test.setTimeout(60_000);

    const email = uniqueEmail("e2e-gate");
    const password = "SecurePass!2024";
    const inviteToken = await createInvite(browser, email);

    // ── 1. Register through the UI form.
    await page.goto(`/login?invite=${inviteToken}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: /create account/i })).toBeVisible();
    await page.locator('input[type="text"]').fill("Gate User");
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.locator('form button[type="submit"]').click();

    // ── 2. No session minted: the "check your email" panel renders, the page
    //    does NOT navigate to /dashboard, and nothing was written to storage.
    await expect(page.locator(".info-banner")).toContainText(/check your email/i);
    await expect(page).toHaveURL(/\/login/);
    expect(await getToken(page), "register must not store a token when verification is required").toBe("");

    // ── 3. A login attempt before verifying is blocked — the page surfaces the
    //    same verification-needed panel (login throws EMAIL_NOT_VERIFIED) and
    //    still mints no session.
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator(".info-banner")).toContainText(/check your email/i);
    await expect(page).toHaveURL(/\/login/);
    expect(await getToken(page), "blocked login must not store a token").toBe("");

    // ── 4. Click the emailed verification link (the deep-link page POSTs
    //    /auth/verify-email and transitions to its success state).
    const token = await fetchVerificationToken(page.request, email);
    await page.goto(`/verify-email/${token}`);
    await expect(page.locator("p.message.success")).toHaveText("Your email has been verified!");

    // ── 5. Now login succeeds and lands authenticated on /dashboard.
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await Promise.all([
      page.waitForURL(/\/dashboard/),
      page.locator('form button[type="submit"]').click(),
    ]);
    await expect(page.locator('.page[data-ready="true"]')).toBeVisible();
    expect(await getToken(page), "login after verification establishes a real session").toBeTruthy();
  });
});
