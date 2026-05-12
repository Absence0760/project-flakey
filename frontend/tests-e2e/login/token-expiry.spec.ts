import { expect, test } from "@playwright/test";

import { signIn } from "../fixtures/helpers";
import { ADMIN_USER } from "../fixtures/users";

/**
 * Token expiry / corruption UX — what the SPA does when the access
 * token in localStorage is no longer accepted by the backend.
 *
 * sign-in-out.spec.ts covers the happy paths (sign in, reload survives
 * bt_token, sign-out clears it). This spec covers the three failure
 * modes the auth singleton has to handle gracefully:
 *
 *   1. The user clears bt_token + bt_refresh (or it was never written
 *      because of a botched migration). On reload, restoreAuth has
 *      nothing, the (app) layout's onMount sees no token, calls
 *      goto('/login').
 *
 *   2. The access token is corrupt (or expired) but the refresh token
 *      is still valid. authFetch on the very first authenticated call
 *      gets 401, calls /auth/refresh, gets a new pair, retries the
 *      original request — the user stays signed in. This is the
 *      foundational requirement for a tolerable session UX: an expired
 *      access token must NOT visibly bounce the user.
 *
 *   3. Both tokens are bad (genuine logout-from-another-tab scenario,
 *      or refresh revoked server-side, or a forged pair). authFetch
 *      gets 401 on the original call, refresh also fails, the
 *      singleton calls clearAuth. The (app) layout's auth subscribe
 *      handler sees the cleared state and goto('/login').
 *
 * If any of these regress, the user either:
 *   - sees a half-loaded broken page (3 fires but no redirect happens), or
 *   - gets logged out unnecessarily on every token expiry (2 regresses
 *     to a clearAuth instead of a refresh).
 *
 * Both are user-visible auth bugs that the test would catch instantly.
 */

// A syntactically valid JWT (3 base64url segments) whose signature
// won't verify against the backend's secret. Backend returns 401; the
// authFetch code paths trip exactly the same way they would for an
// expired-by-time token.
const FORGED_JWT = [
  // header { alg: HS256, typ: JWT }
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  // payload { sub: 999, orgId: 999, exp: 1893456000 } — far-future expiry so
  // the rejection has to be the SIGNATURE check, not the exp check.
  "eyJzdWIiOjk5OSwib3JnSWQiOjk5OSwiZXhwIjoxODkzNDU2MDAwfQ",
  // signature: random base64 that doesn't HMAC-match anything
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
].join(".");
// A non-JWT refresh token. The backend's refresh handler rejects any
// token it can't decode + look up in the refresh_tokens table.
const FORGED_REFRESH = "this-refresh-token-was-never-issued-by-anyone";

test.describe("token expiry / corruption — auth singleton recovery", () => {
  // These tests sign in from a clean state per-test (rather than using
  // the shared ADMIN storageState) so each one can manipulate
  // localStorage independently without polluting the storage state
  // file other specs rely on.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("clearing bt_token + bt_refresh on a signed-in page bounces to /login on reload", async ({ page }) => {
    await signIn(page, ADMIN_USER);
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });

    // Yank both tokens out of localStorage and refresh. restoreAuth on
    // the next mount finds nothing and the (app) layout's onMount
    // calls goto('/login').
    await page.evaluate(() => {
      localStorage.removeItem("bt_token");
      localStorage.removeItem("bt_refresh");
      localStorage.removeItem("bt_user");
    });
    await page.reload();
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });

  test("forged access token + valid refresh: silently refreshes, user stays signed in", async ({ page }) => {
    await signIn(page, ADMIN_USER);
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });

    // Replace the access token with a forged-signature JWT but keep
    // the genuine refresh token. The first authFetch after reload
    // (loadOrgs in the layout) gets 401, the singleton calls
    // /auth/refresh, the refresh token is still valid, a new pair
    // comes back, the original call retries and succeeds.
    await page.evaluate((forged) => {
      localStorage.setItem("bt_token", forged);
    }, FORGED_JWT);

    await page.reload();

    // Stayed on /dashboard.
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
    // Sidebar still hydrated with the user's identity — proves the
    // refresh + retry round-trip actually completed.
    await expect(page.locator("aside.sidebar .user-email")).toHaveText(ADMIN_USER.email);
    // And bt_token has been replaced with a fresh one (no longer the
    // forged value).
    const tokenAfter = await page.evaluate(() => localStorage.getItem("bt_token"));
    expect(tokenAfter).not.toEqual(FORGED_JWT);
    expect(tokenAfter, "refreshed token must be populated").toBeTruthy();
  });

  test("forged access token + forged refresh: refresh fails, clearAuth fires, bounce to /login", async ({ page }) => {
    await signIn(page, ADMIN_USER);
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });

    // Forge both — the access-token rejection forces the refresh path,
    // and the refresh-token rejection forces clearAuth.
    await page.evaluate(([t, r]) => {
      localStorage.setItem("bt_token", t);
      localStorage.setItem("bt_refresh", r);
    }, [FORGED_JWT, FORGED_REFRESH]);

    await page.reload();

    // Either path takes us to /login: the layout's onMount sees a
    // token in localStorage so it doesn't redirect immediately, but
    // loadOrgs' authFetch trips the 401 → refresh-fail → clearAuth,
    // which fires the subscribe handler installed by the layout and
    // triggers goto('/login').
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

    // localStorage cleared as a side-effect.
    const tokens = await page.evaluate(() => ({
      token: localStorage.getItem("bt_token"),
      refresh: localStorage.getItem("bt_refresh"),
    }));
    expect(tokens.token, "clearAuth must remove bt_token").toBeNull();
    expect(tokens.refresh, "clearAuth must remove bt_refresh").toBeNull();
  });
});
