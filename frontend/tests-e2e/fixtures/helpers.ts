import { expect, type Page } from "@playwright/test";

import type { SeededUser } from "./users";

/**
 * Drive the email-password sign-in form. Shared by globalSetup
 * (fixtures/auth.ts) and the /login spec's affordance tests so the
 * hydration-wait + selector behaviour stays in one place.
 *
 * Returns once the form has been submitted — the caller is
 * responsible for asserting the destination URL (or that we stayed
 * on /login for failed sign-ins).
 *
 * Why the explicit `networkidle` wait: Playwright can click the
 * submit button before Svelte 5 has bound the form's `onsubmit`.
 * With nothing preventing default, the form's native GET fires and
 * the page navigates to /login?email=...&password=... — visually
 * identical to "still on /login" but with no auth POST attempted.
 * Waiting for networkidle covers Vite HMR connection + the dynamic
 * import of `auth.ts`.
 */
export async function signIn(
  page: Page,
  creds: Pick<SeededUser, "email" | "password">,
): Promise<void> {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");

  await page.locator('input[type="email"]').fill(creds.email);
  await page.locator('input[type="password"]').fill(creds.password);
  await page.locator('form button[type="submit"]').click();
}

/**
 * Click through the sidebar profile menu → Sign out. Asserts the
 * post-logout redirect to /login.
 */
export async function signOut(page: Page): Promise<void> {
  await page.locator(".profile-btn").click();
  await page.getByRole("button", { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/login/);
}
