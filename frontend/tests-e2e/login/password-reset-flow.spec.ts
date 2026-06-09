import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * Password-reset COMPLETION happy path — the half that auth-flows.spec.ts
 * deliberately leaves uncovered.
 *
 * Every reset-password test in auth-flows.spec.ts asserts a 400 (missing
 * token / weak password / unknown token). None of them prove that a VALID
 * token actually rotates the password. This spec closes that gap end to end:
 *
 *   register a known user (via an admin invite, since ALLOW_REGISTRATION is
 *   off in dev) → POST /auth/forgot-password → read the real reset link out
 *   of Mailpit → reset with that token → assert the NEW password logs in AND
 *   the OLD password is now rejected.
 *
 * The reset token is SMTP-only — it never appears in any API response body
 * (auth.ts forgot-password returns just `{ ok: true }`), so Mailpit is the
 * only honest way to obtain a valid one in dev. Reading it from the mail sink
 * is a real signal, not a hack: it's exactly the link a user would click.
 *
 * Token consumption is one-time-use (auth.ts NULLs password_reset_token on
 * use), so each reset needs its own forgot-password request + fresh capture.
 */

const BACKEND = "http://localhost:3000";
// Mailpit web API. Overridable via MAILPIT_URL so CI can pin it to 127.0.0.1
// — on the GitHub runner `localhost` resolves to ::1 first, but Docker
// publishes the Mailpit port on IPv4 only, so the default would ECONNREFUSED.
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";
// The reset link Mailpit captures points at the frontend, whose base URL is
// FRONTEND_URL (default http://localhost:7778 — the Playwright baseURL too).
const RESET_LINK_RE = /\/reset-password\/([a-f0-9]{64})/;

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

/**
 * Create a brand-new, known-credential user by minting an admin invite
 * (the invite endpoint returns its token directly) and registering against
 * it. Returns the email + password so the caller can drive the reset and
 * then assert login behaviour before/after.
 */
async function registerFreshUser(
  request: APIRequestContext,
  adminToken: string,
  orgId: number,
): Promise<{ email: string; password: string }> {
  const email = `e2e-reset-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}@example.test`;
  const password = "OriginalPass!2024";

  const inviteRes = await request.post(`${BACKEND}/orgs/${orgId}/invites`, {
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    data: { email, role: "viewer" },
  });
  expect(inviteRes.status(), "admin invite should succeed").toBe(201);
  const invite = (await inviteRes.json()) as { invite_token: string };

  const regRes = await request.post(`${BACKEND}/auth/register`, {
    headers: { "Content-Type": "application/json" },
    data: { email, password, name: "Reset Subject", invite_token: invite.invite_token },
  });
  expect(regRes.status(), "register with invite token should succeed").toBe(201);

  return { email, password };
}

/**
 * Trigger forgot-password for `email`, then poll Mailpit for the resulting
 * "Reset your password" message and extract the 64-hex token from its link.
 *
 * Polls on a real signal — the message landing in Mailpit's inbox — via
 * expect.poll (no fixed sleep). sendPasswordResetEmail is fire-and-forget on
 * the backend, so the mail lands a beat after the 200, not synchronously.
 */
async function requestResetTokenViaMailpit(
  request: APIRequestContext,
  email: string,
): Promise<string> {
  // Note the time so we only match a message that arrives for THIS request,
  // not a stale one from an earlier run with a colliding (random) address.
  const sinceMs = Date.now();

  const forgot = await request.post(`${BACKEND}/auth/forgot-password`, {
    headers: { "Content-Type": "application/json" },
    data: { email },
  });
  expect(forgot.status(), "forgot-password is enumeration-resistant: always 200").toBe(200);

  let token = "";
  await expect
    .poll(
      async () => {
        // Mailpit's search API filters by recipient; newest first.
        const res = await request.get(
          `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
        );
        if (!res.ok()) return "";
        const list = (await res.json()) as {
          messages: { ID: string; Subject: string; Created: string }[];
        };
        const hit = list.messages.find(
          (m) =>
            /reset/i.test(m.Subject) && new Date(m.Created).getTime() >= sinceMs - 2_000,
        );
        if (!hit) return "";

        const msgRes = await request.get(`${MAILPIT}/api/v1/message/${hit.ID}`);
        if (!msgRes.ok()) return "";
        const msg = (await msgRes.json()) as { Text: string; HTML: string };
        const match =
          (msg.Text ?? "").match(RESET_LINK_RE) ?? (msg.HTML ?? "").match(RESET_LINK_RE);
        token = match?.[1] ?? "";
        return token;
      },
      {
        message: `password-reset email for ${email} should arrive in Mailpit with a /reset-password/<token> link`,
      },
    )
    .toMatch(/^[a-f0-9]{64}$/);

  return token;
}

/** Resolve the admin's org id once, for minting invites. */
async function adminOrgId(page: Page, adminToken: string): Promise<number> {
  const meRes = await page.request.get(`${BACKEND}/auth/me`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const me = (await meRes.json()) as { user: { orgId: number }; orgs: { id: number }[] };
  return me.orgs[0]?.id ?? me.user.orgId;
}

test.describe("auth — password reset completion (happy path)", () => {
  // Mints invites as the seeded admin (open registration is off in dev), so
  // this block needs an authed admin session rather than empty storage.
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("a valid reset token rotates the password: new password logs in, old is rejected", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto("/dashboard");
    const adminToken = await getToken(page);
    const orgId = await adminOrgId(page, adminToken);

    // Arrange — a fresh user with known original credentials.
    const { email, password: oldPassword } = await registerFreshUser(
      page.request,
      adminToken,
      orgId,
    );
    // Sanity: the original password works before we touch anything.
    const preLogin = await page.request.post(`${BACKEND}/auth/login`, {
      headers: { "Content-Type": "application/json" },
      data: { email, password: oldPassword },
    });
    expect(preLogin.status(), "original credentials should log in before reset").toBe(200);

    // Act — obtain a real reset token from Mailpit and complete the reset.
    const resetToken = await requestResetTokenViaMailpit(page.request, email);
    const newPassword = "RotatedPass!2025";
    const resetRes = await page.request.post(`${BACKEND}/auth/reset-password`, {
      headers: { "Content-Type": "application/json" },
      data: { token: resetToken, password: newPassword },
    });
    expect(resetRes.status(), "reset-password with a VALID token should succeed").toBe(200);
    expect((await resetRes.json()).ok).toBe(true);

    // Assert — the new password works…
    const newLogin = await page.request.post(`${BACKEND}/auth/login`, {
      headers: { "Content-Type": "application/json" },
      data: { email, password: newPassword },
    });
    expect(newLogin.status(), "login with the NEW password should succeed").toBe(200);

    // …and the old password no longer does.
    const oldLogin = await page.request.post(`${BACKEND}/auth/login`, {
      headers: { "Content-Type": "application/json" },
      data: { email, password: oldPassword },
    });
    expect(oldLogin.status(), "login with the OLD password should be rejected").toBe(401);

    // The token is one-time use — replaying it must now 400.
    const replay = await page.request.post(`${BACKEND}/auth/reset-password`, {
      headers: { "Content-Type": "application/json" },
      data: { token: resetToken, password: "AnotherPass!2026" },
    });
    expect(replay.status(), "a consumed reset token must not work twice").toBe(400);
  });

  test("the /reset-password/[token] deep-link page completes the reset in the browser", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto("/dashboard");
    const adminToken = await getToken(page);
    const orgId = await adminOrgId(page, adminToken);

    // Arrange — fresh user; capture a real token from the reset email.
    const { email } = await registerFreshUser(page.request, adminToken, orgId);
    const resetToken = await requestResetTokenViaMailpit(page.request, email);

    // Act — drive the actual deep-link page the user would land on.
    const uiPassword = "BrowserPass!2027";
    await page.goto(`/reset-password/${resetToken}`);
    // The form renders synchronously (no onMount fetch), but wait for the
    // inputs to be present before filling so we drive a hydrated form.
    const passwordInputs = page.locator('input[type="password"]');
    await expect(passwordInputs.first()).toBeVisible();
    await passwordInputs.first().fill(uiPassword); // New password
    await passwordInputs.last().fill(uiPassword); // Confirm password
    await page.getByRole("button", { name: /reset password/i }).click();

    // Assert — the page shows the success state (real DOM signal, no sleep).
    await expect(page.locator("p.message.success")).toContainText(
      "Your password has been reset",
    );
    // The success state swaps the form for a "Sign in" button.
    await expect(page.getByRole("button", { name: /^sign in$/i })).toBeVisible();

    // And the browser-set password actually authenticates.
    const newLogin = await page.request.post(`${BACKEND}/auth/login`, {
      headers: { "Content-Type": "application/json" },
      data: { email, password: uiPassword },
    });
    expect(newLogin.status(), "password set via the deep-link page should log in").toBe(200);
  });
});
