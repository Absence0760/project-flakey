import { test, expect } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";

/**
 * SSO e2e proof (Phase 14 prototype) — drives a real OIDC Authorization Code
 * + PKCE flow against a local Keycloak entirely through the browser.
 *
 * This is the load-bearing evidence that Flakey SSO is e2e-testable with
 * Playwright + Keycloak, with NO online signup: the `flakey` realm is seeded
 * deterministically from infra/keycloak/flakey-realm.json (`pnpm idp:up`), so
 * the login form, the redirect, and the token exchange are all reproducible.
 *
 * What it exercises (the same path a user hits once Flakey has an SSO button):
 *   1. Build the /authorize URL (code flow + PKCE S256).
 *   2. Playwright fills Keycloak's hosted login form and submits.
 *   3. Keycloak redirects to the registered callback with `?code=`.
 *   4. Exchange the code at /token and assert a valid access token whose
 *      claims carry the seeded email + the `flakey_roles` mapper.
 *
 * There is NO Flakey app integration yet (SSO is unbuilt), so the callback is
 * a stub the test fulfils — the point is to prove the IdP contract + browser
 * automation, not app wiring. When real SSO lands, the app-facing specs live
 * under the main e2e config and assert a logged-in Flakey session instead.
 *
 * Prereq: `pnpm idp:up`. Run: `cd frontend && pnpm test:e2e:sso`.
 */

const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? "http://localhost:8081";
const REALM = "flakey";
const CLIENT_ID = "flakey-web";
const CLIENT_SECRET = "flakey-dev-secret";
const REDIRECT_URI = "http://localhost:7778/auth/callback";
const ISSUER = `${KEYCLOAK_URL}/realms/${REALM}`;

const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function pkcePair() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

test.describe("OIDC Authorization Code + PKCE against local Keycloak", () => {
  test("seeded SSO user logs in via the Keycloak UI and the issued token carries email + flakey_roles", async ({ page, request }) => {
    const { verifier, challenge } = pkcePair();
    const state = b64url(randomBytes(16));

    const authUrl = new URL(`${ISSUER}/protocol/openid-connect/auth`);
    authUrl.searchParams.set("client_id", CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid email profile");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    // 1–2. Land on Keycloak's hosted login form and authenticate.
    await page.goto(authUrl.toString());
    await expect(page.locator("#kc-form-login")).toBeVisible();
    await page.fill("#username", "sso.admin@example.com");
    await page.fill("#password", "ssopassword");

    // 3. Keycloak redirects back to the callback with ?code= & matching state.
    // Nothing serves :7778/auth/callback in this IdP-contract proof. We can't
    // stub it with page.route(): Playwright doesn't intercept the *target* of a
    // server-side 302 for a top-level navigation — the browser follows the
    // redirect at the network layer, so the route never fires and the
    // navigation dies with ERR_CONNECTION_REFUSED. (Locally a running dev
    // server on :7778 silently answers it and masks the bug; in CI nothing is
    // there, so the old `waitForURL` hung for the full timeout.) Instead, read
    // the code straight off the callback *request* the browser issues — that
    // event fires whether or not anything ever answers it.
    const callbackReq = page.waitForRequest((r) => r.url().startsWith(REDIRECT_URI));
    await page.click("#kc-login");
    const cbUrl = new URL((await callbackReq).url());
    const code = cbUrl.searchParams.get("code");
    expect(code, "authorization code present on the callback").toBeTruthy();
    expect(cbUrl.searchParams.get("state"), "state round-trips intact").toBe(state);

    // 4. Exchange the code for tokens (confidential client + PKCE verifier).
    const tokenRes = await request.post(`${ISSUER}/protocol/openid-connect/token`, {
      form: {
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code_verifier: verifier,
      },
    });
    expect(tokenRes.ok(), `token exchange status ${tokenRes.status()}`).toBeTruthy();
    const tokens = await tokenRes.json();
    expect(tokens.access_token, "access_token issued").toBeTruthy();
    expect(tokens.id_token, "id_token issued (openid scope)").toBeTruthy();

    const claims = decodeJwtPayload(tokens.access_token as string);
    expect(claims.iss).toBe(ISSUER);
    expect(claims.email).toBe("sso.admin@example.com");
    // The realm-role mapper (infra/keycloak/flakey-realm.json) is what Flakey's
    // SSO would consume to assign an org role — assert it lands in the token.
    expect(claims.flakey_roles).toContain("flakey-admin");
  });

  test("bad credentials are rejected on the Keycloak form (negative path)", async ({ page }) => {
    const { challenge } = pkcePair();
    const authUrl = new URL(`${ISSUER}/protocol/openid-connect/auth`);
    authUrl.searchParams.set("client_id", CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid");
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    await page.goto(authUrl.toString());
    await page.fill("#username", "sso.admin@example.com");
    await page.fill("#password", "wrong-password");
    await page.click("#kc-login");

    // Stays on Keycloak with an inline error — no redirect, no code issued.
    await expect(page.locator("#input-error, .kc-feedback-text, .alert-error")).toBeVisible();
    expect(page.url()).toContain("/realms/flakey/");
    expect(page.url()).not.toContain("/auth/callback");
  });
});
