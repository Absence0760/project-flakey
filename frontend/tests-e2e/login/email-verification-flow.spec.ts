import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * Email-verification SUCCESS path.
 *
 * auth-flows.spec.ts already pins the 400 cases (missing token, unknown
 * token, resend/forgot enumeration-resistance). The success half was
 * uncovered because the verification token is sent by email ONLY — it
 * never appears in any API response body (POST /auth/register mints it
 * into users.email_verification_token and emails it via
 * sendVerificationEmail; the response carries only emailVerificationRequired).
 *
 * The e2e-friendly way to get the real token is the same sink the app
 * actually writes to in dev: Mailpit. `pnpm db:up` starts Mailpit on
 * :1025 (SMTP) / :8025 (HTTP UI + API), and email.ts builds the link as
 * `${FRONTEND_URL}/verify-email/${token}`. So we register a freshly
 * invited user, poll Mailpit's HTTP API for the "Verify your email"
 * message, pull the token out of the message body, and exercise the
 * verify-email contract end to end:
 *
 *   1. POST /auth/verify-email with the real token → 200 { ok, email },
 *      and the verified state actually flips — proven by a replay
 *      returning 400 (the token is NULLed on consumption, so a second
 *      use can only succeed if the row was mutated to verified).
 *   2. POST /auth/resend-verification mints a *fresh, usable* token
 *      (a new email arrives, and that new token verifies successfully).
 *   3. The /verify-email/[token] UI deep-link drives the same POST in
 *      the browser and renders "Your email has been verified!".
 *
 * No sleeps: every wait is on a real signal — the invite/register HTTP
 * responses, Mailpit message arrival (expect.poll), and the page's
 * own verifying→success transition.
 */

const BACKEND = "http://localhost:3000";
// Mailpit web API. Overridable via MAILPIT_URL so CI can pin it to 127.0.0.1
// — on the GitHub runner `localhost` resolves to ::1 first, but Docker
// publishes the Mailpit port on IPv4 only, so the default would ECONNREFUSED.
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

/** Acme org id for the seeded admin — where we drop the invites. */
async function adminOrgId(request: APIRequestContext, token: string): Promise<number> {
  const meRes = await request.get(`${BACKEND}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const me = (await meRes.json()) as { user: { orgId: number }; orgs: { id: number }[] };
  return me.orgs[0]?.id ?? me.user.orgId;
}

/**
 * Invite + register a brand-new user. Registration mints the
 * verification token and fires the email. Returns the credentials so
 * the caller can hit the email-driven endpoints for that user.
 */
async function inviteAndRegister(
  request: APIRequestContext,
  adminToken: string,
  orgId: number,
): Promise<{ email: string; password: string }> {
  const email = `e2e-verify-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}@example.test`;
  const password = "SecurePass!2024";

  const inviteRes = await request.post(`${BACKEND}/orgs/${orgId}/invites`, {
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    data: { email, role: "viewer" },
  });
  expect(inviteRes.status(), "admin invite should succeed").toBe(201);
  const invite = (await inviteRes.json()) as { invite_token: string };

  const regRes = await request.post(`${BACKEND}/auth/register`, {
    headers: { "Content-Type": "application/json" },
    data: { email, password, name: "Verify Flow", invite_token: invite.invite_token },
  });
  expect(regRes.status(), "register with valid invite_token should succeed").toBe(201);

  return { email, password };
}

/**
 * Poll Mailpit for the most recent "Verify your email" message addressed
 * to `email` and return the verification token embedded in its body.
 *
 * `after` filters out any earlier verification mail for the same address
 * (resend tests send two), so we only ever pick up the message minted
 * after a known point in time. We wait on real signals: the message
 * showing up in the inbox (expect.poll over the search API), then the
 * token regex matching the message body.
 */
async function fetchVerificationToken(
  request: APIRequestContext,
  email: string,
  after = 0,
): Promise<string> {
  let token = "";

  await expect
    .poll(
      async () => {
        // Mailpit search by recipient; newest messages come back first.
        const searchRes = await request.get(
          `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email} subject:"Verify your email"`)}&limit=20`,
        );
        if (!searchRes.ok()) return "";
        const { messages } = (await searchRes.json()) as {
          messages: { ID: string; Created: string }[];
        };

        for (const msg of messages) {
          if (after && new Date(msg.Created).getTime() < after) continue;
          const msgRes = await request.get(`${MAILPIT}/api/v1/message/${msg.ID}`);
          if (!msgRes.ok()) continue;
          const body = (await msgRes.json()) as { Text: string; HTML: string };
          const haystack = `${body.Text}\n${body.HTML}`;
          // Link shape from backend/src/email.ts:33 — /verify-email/<64-hex>.
          const m = haystack.match(/\/verify-email\/([a-f0-9]{64})/);
          if (m) {
            token = m[1];
            return token;
          }
        }
        return "";
      },
      {
        message: `verification email for ${email} should arrive in Mailpit with a token`,
        // Polls the real inbox; succeeds the moment the message lands.
        timeout: 15_000,
      },
    )
    .not.toBe("");

  return token;
}

test.describe("auth — email verification success path", () => {
  // Pre-auth surface for the verify-email endpoint itself; we still need
  // an authed admin to create invites, so we sign in via storage state.
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("a freshly minted verification token verifies the email (200), and the verified state flips — replay is rejected", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const adminToken = await getToken(page);
    const orgId = await adminOrgId(page.request, adminToken);

    const { email } = await inviteAndRegister(page.request, adminToken, orgId);

    // Pull the real token out of the verification email Mailpit captured.
    const token = await fetchVerificationToken(page.request, email);

    // ── First use: succeeds and echoes the verified email.
    const verifyRes = await page.request.post(`${BACKEND}/auth/verify-email`, {
      headers: { "Content-Type": "application/json" },
      data: { token },
    });
    expect(verifyRes.status(), "valid verification token should succeed").toBe(200);
    const verified = (await verifyRes.json()) as { ok: boolean; email: string };
    expect(verified.ok).toBe(true);
    expect(verified.email.toLowerCase()).toBe(email.toLowerCase());

    // ── Replay: the verified state actually flipped, so the token was
    //    NULLed on consumption. A second use can't find the row → 400.
    //    This is the real signal that the UPDATE landed (one-time use).
    const replayRes = await page.request.post(`${BACKEND}/auth/verify-email`, {
      headers: { "Content-Type": "application/json" },
      data: { token },
    });
    expect(replayRes.status(), "consumed token must 400 — proves email_verified flipped + token cleared").toBe(400);
    const replay = (await replayRes.json()) as { error: string };
    expect(replay.error).toMatch(/invalid|expired/i);
  });

  test("POST /auth/resend-verification mints a fresh, usable token that verifies the email", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const adminToken = await getToken(page);
    const orgId = await adminOrgId(page.request, adminToken);

    const { email } = await inviteAndRegister(page.request, adminToken, orgId);

    // Consume the registration token first so we're unambiguously
    // testing the resend-minted one (and so the user is unverified again
    // before resend runs — resend only mints when email_verified=false).
    const firstToken = await fetchVerificationToken(page.request, email);
    const firstVerify = await page.request.post(`${BACKEND}/auth/verify-email`, {
      headers: { "Content-Type": "application/json" },
      data: { token: firstToken },
    });
    expect(firstVerify.status()).toBe(200);

    // Already-verified users get a no-op 200 from resend (enumeration
    // resistance) and NO new token. To prove resend mints a usable token
    // we register a second fresh user and resend before verifying.
    const second = await inviteAndRegister(page.request, adminToken, orgId);
    // Drain the registration email first so we can target the resend one.
    const regToken = await fetchVerificationToken(page.request, second.email);
    expect(regToken).toMatch(/^[a-f0-9]{64}$/);

    const resendAt = Date.now();
    const resendRes = await page.request.post(`${BACKEND}/auth/resend-verification`, {
      headers: { "Content-Type": "application/json" },
      data: { email: second.email },
    });
    expect(resendRes.status(), "resend-verification returns 200 for an unverified user").toBe(200);
    expect((await resendRes.json()).ok).toBe(true);

    // The resend email (minted after `resendAt`) carries a usable token.
    const resentToken = await fetchVerificationToken(page.request, second.email, resendAt);
    expect(resentToken).toMatch(/^[a-f0-9]{64}$/);

    const verifyRes = await page.request.post(`${BACKEND}/auth/verify-email`, {
      headers: { "Content-Type": "application/json" },
      data: { token: resentToken },
    });
    expect(verifyRes.status(), "the resend-minted token should verify successfully").toBe(200);
    expect((await verifyRes.json()).ok).toBe(true);
  });

  test("the /verify-email/[token] UI deep-link verifies in the browser and renders success", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const adminToken = await getToken(page);
    const orgId = await adminOrgId(page.request, adminToken);

    const { email } = await inviteAndRegister(page.request, adminToken, orgId);
    const token = await fetchVerificationToken(page.request, email);

    // Drive the deep-link page. onMount POSTs /auth/verify-email and
    // transitions status 'verifying' → 'success'. We wait on the
    // rendered success message (a real DOM signal), not a timer.
    await page.goto(`/verify-email/${token}`);
    await expect(page.locator("p.message.success")).toHaveText("Your email has been verified!");
    // The success state offers a Sign-in CTA back to /login.
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  });
});
