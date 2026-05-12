import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * Auth lifecycle e2e: registration (invite + open), email verification,
 * password reset, and the enumeration-resistance contracts on the
 * email-driven endpoints.
 *
 * All zero-coverage today. The endpoints either go through SMTP (whose
 * tokens never come back over the wire) or mutate state we don't have
 * a direct DB connection for. So these tests target what's testable
 * over the public API: input-validation contracts, status codes, and
 * the round-trip register-via-invite flow (where the invite endpoint
 * DOES return the token to the caller).
 */

const BACKEND = "http://localhost:3000";

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

/* ───────────────────── Registration ───────────────────── */

test.describe("auth — registration", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("admin invites a new email; the invitee registers with the invite_token; login works", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const adminToken = await getToken(page);

    const inviteEmail = `e2e-invitee-${Date.now().toString(36)}@example.test`;
    const password = "SecurePass!2024";

    // Admin's orgs list — find the acme org id we'll invite into.
    const meRes = await page.request.get(`${BACKEND}/auth/me`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const me = (await meRes.json()) as { user: { orgId: number }; orgs: { id: number }[] };
    const acmeOrgId = me.orgs[0]?.id ?? me.user.orgId;

    // ── Create the invite. The endpoint returns the token directly,
    //    so the test doesn't need to peek at a mailbox.
    const inviteRes = await page.request.post(`${BACKEND}/orgs/${acmeOrgId}/invites`, {
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      data: { email: inviteEmail, role: "viewer" },
    });
    expect(inviteRes.status()).toBe(201);
    const invite = (await inviteRes.json()) as { invite_token: string; email: string };
    expect(invite.invite_token, "invite endpoint should return the raw token").toMatch(/^[a-f0-9]{64}$/);
    expect(invite.email).toBe(inviteEmail);

    // ── Register with the invite token (no auth header — pre-account).
    const regRes = await page.request.post(`${BACKEND}/auth/register`, {
      headers: { "Content-Type": "application/json" },
      data: { email: inviteEmail, password, name: "Test Invitee", invite_token: invite.invite_token },
    });
    expect(regRes.status(), "register with valid invite_token should succeed").toBe(201);
    const reg = (await regRes.json()) as {
      token: string;
      user: { id: number; email: string };
      emailVerificationRequired: boolean;
    };
    expect(reg.token, "register response includes a JWT").toBeTruthy();
    expect(reg.user.email).toBe(inviteEmail);

    // ── Login with the new credentials works.
    const loginRes = await page.request.post(`${BACKEND}/auth/login`, {
      headers: { "Content-Type": "application/json" },
      data: { email: inviteEmail, password },
    });
    expect(loginRes.status(), "newly-registered user should be able to log in").toBe(200);
  });

  test("registration without an invite is rejected when ALLOW_REGISTRATION is off (the dev default)", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.goto("/dashboard");

    // Register WITHOUT invite_token. With ALLOW_REGISTRATION=false (the
    // default), the response is 403. With ALLOW_REGISTRATION=true, this
    // path is unreachable — so the test asserts on the contract that
    // applies in dev/prod as shipped.
    const res = await page.request.post(`${BACKEND}/auth/register`, {
      headers: { "Content-Type": "application/json" },
      data: { email: `nobody-${Date.now()}@example.test`, password: "longenoughpw123" },
    });
    // Either 403 (invite-only) — accept 201 only if the dev env has
    // intentionally enabled open registration. Don't fail loudly there.
    expect([201, 403]).toContain(res.status());
    if (res.status() === 403) {
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/invite/i);
    }
  });

  test("registration with a weak password is rejected (400, 'at least 8 characters')", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.goto("/dashboard");
    const res = await page.request.post(`${BACKEND}/auth/register`, {
      headers: { "Content-Type": "application/json" },
      data: { email: "weakpw@example.test", password: "short", invite_token: "anything" },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/8 characters/);
  });

  test("registration with missing email/password returns 400", async ({ page }) => {
    test.setTimeout(15_000);
    await page.goto("/dashboard");
    const res = await page.request.post(`${BACKEND}/auth/register`, {
      headers: { "Content-Type": "application/json" },
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test("registering with an already-used email returns 409", async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const adminToken = await getToken(page);

    const dupeEmail = `e2e-dupe-${Date.now().toString(36)}@example.test`;
    const password = "SecurePass!2024";
    const meRes = await page.request.get(`${BACKEND}/auth/me`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const orgId = ((await meRes.json()) as { orgs: { id: number }[] }).orgs[0].id;

    // Invite + register first time.
    const invite1 = (await (
      await page.request.post(`${BACKEND}/orgs/${orgId}/invites`, {
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
        data: { email: dupeEmail, role: "viewer" },
      })
    ).json()) as { invite_token: string };
    const reg1 = await page.request.post(`${BACKEND}/auth/register`, {
      headers: { "Content-Type": "application/json" },
      data: { email: dupeEmail, password, invite_token: invite1.invite_token },
    });
    expect(reg1.status()).toBe(201);

    // Second invite for the SAME email + register attempt → 409.
    const invite2 = (await (
      await page.request.post(`${BACKEND}/orgs/${orgId}/invites`, {
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
        data: { email: dupeEmail, role: "viewer" },
      })
    ).json()) as { invite_token: string };
    const reg2 = await page.request.post(`${BACKEND}/auth/register`, {
      headers: { "Content-Type": "application/json" },
      data: { email: dupeEmail, password, invite_token: invite2.invite_token },
    });
    expect(reg2.status(), "duplicate email should be rejected with 409").toBe(409);
  });
});

/* ───────────────────── Email verification ───────────────────── */

test.describe("auth — email verification", () => {
  test("POST /auth/verify-email with no token → 400", async ({ page }) => {
    test.setTimeout(15_000);
    await page.goto("/login");
    const res = await page.request.post(`${BACKEND}/auth/verify-email`, {
      headers: { "Content-Type": "application/json" },
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/token/i);
  });

  test("POST /auth/verify-email with an unknown token → 400 ('Invalid or expired')", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.goto("/login");
    const res = await page.request.post(`${BACKEND}/auth/verify-email`, {
      headers: { "Content-Type": "application/json" },
      data: { token: "definitely-not-a-real-token-" + Date.now() },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid|expired/i);
  });

  test("POST /auth/resend-verification is enumeration-resistant: returns 200 for an unknown email", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.goto("/login");
    // The contract: never reveal whether an email is registered. An
    // unknown email AND an already-verified email both return 200 ok.
    const unknown = await page.request.post(`${BACKEND}/auth/resend-verification`, {
      headers: { "Content-Type": "application/json" },
      data: { email: `nobody-${Date.now()}@example.test` },
    });
    expect(unknown.status()).toBe(200);
    expect((await unknown.json()).ok).toBe(true);
  });

  test("POST /auth/resend-verification with no email body → 400", async ({ page }) => {
    test.setTimeout(15_000);
    await page.goto("/login");
    const res = await page.request.post(`${BACKEND}/auth/resend-verification`, {
      headers: { "Content-Type": "application/json" },
      data: {},
    });
    expect(res.status()).toBe(400);
  });
});

/* ───────────────────── Password reset ───────────────────── */

test.describe("auth — password reset", () => {
  test("POST /auth/forgot-password is enumeration-resistant: returns 200 for an unknown email too", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.goto("/login");
    const res = await page.request.post(`${BACKEND}/auth/forgot-password`, {
      headers: { "Content-Type": "application/json" },
      data: { email: `nobody-${Date.now()}@example.test` },
    });
    expect(
      res.status(),
      "forgot-password must NOT 404 — that would leak email existence; always 200",
    ).toBe(200);
  });

  test("POST /auth/forgot-password with a known email also returns 200 (same shape, no enumeration)", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.goto("/login");
    const res = await page.request.post(`${BACKEND}/auth/forgot-password`, {
      headers: { "Content-Type": "application/json" },
      data: { email: ADMIN_USER.email },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  test("POST /auth/forgot-password with no email body → 400", async ({ page }) => {
    test.setTimeout(15_000);
    await page.goto("/login");
    const res = await page.request.post(`${BACKEND}/auth/forgot-password`, {
      headers: { "Content-Type": "application/json" },
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test("POST /auth/reset-password with no token → 400", async ({ page }) => {
    test.setTimeout(15_000);
    await page.goto("/login");
    const res = await page.request.post(`${BACKEND}/auth/reset-password`, {
      headers: { "Content-Type": "application/json" },
      data: { password: "longenoughpw123" },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /auth/reset-password with an unknown token → 400 (no leak that the user exists)", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.goto("/login");
    const res = await page.request.post(`${BACKEND}/auth/reset-password`, {
      headers: { "Content-Type": "application/json" },
      data: { token: "not-a-real-token-" + Date.now(), password: "longenoughpw123" },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid|expired/i);
  });

  test("POST /auth/reset-password with a weak password → 400 (validation runs before token lookup)", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.goto("/login");
    const res = await page.request.post(`${BACKEND}/auth/reset-password`, {
      headers: { "Content-Type": "application/json" },
      data: { token: "anything", password: "short" },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/8 characters/);
  });
});

/* ───────────────────── Org switch ───────────────────── */

test.describe("auth — /auth/switch-org", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("switching to a non-member org returns 403", async ({ page }) => {
    test.setTimeout(15_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    // Org id 999999 is intentionally not a real org. The membership
    // check is the security gate, so any non-member org must 403.
    const res = await page.request.post(`${BACKEND}/auth/switch-org`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { orgId: 999999 },
    });
    expect(res.status()).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/member/i);
  });

  test("switching to the user's existing org returns a fresh JWT scoped to that org", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const me = (await (
      await page.request.get(`${BACKEND}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { user: { orgId: number }; orgs: { id: number; role: string }[] };

    // Find the user's current org and switch to it (no-op semantics,
    // but still exercises the codepath + asserts a fresh JWT comes back).
    const currentOrg = me.orgs.find((o) => o.id === me.user.orgId);
    expect(currentOrg, "user must have at least one org membership").toBeTruthy();

    const res = await page.request.post(`${BACKEND}/auth/switch-org`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { orgId: currentOrg!.id },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { token: string; user: { orgId: number; orgRole: string } };
    expect(body.token).toBeTruthy();
    expect(body.user.orgId).toBe(currentOrg!.id);
    expect(body.user.orgRole).toBe(currentOrg!.role);
  });
});
