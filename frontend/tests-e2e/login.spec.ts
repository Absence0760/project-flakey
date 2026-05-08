import { test, expect } from "@playwright/test";

const SEED_EMAIL = "admin@example.com";
const SEED_PASSWORD = "admin";

test.beforeEach(async ({ page }) => {
  await page.goto("/login");
});

test("login with seeded admin redirects to /dashboard and stores bt_token", async ({ page }) => {
  await page.getByPlaceholder("you@example.com").fill(SEED_EMAIL);
  await page.getByPlaceholder("Password").fill(SEED_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).first().click();

  await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });

  const token = await page.evaluate(() => localStorage.getItem("bt_token"));
  expect(token, "bt_token should be set after a successful login").toBeTruthy();
});

test("invalid password shows an error and stays on /login", async ({ page }) => {
  await page.getByPlaceholder("you@example.com").fill(SEED_EMAIL);
  await page.getByPlaceholder("Password").fill("wrong-password");
  await page.getByRole("button", { name: /sign in/i }).first().click();

  await expect(page).toHaveURL(/\/login/);
  const token = await page.evaluate(() => localStorage.getItem("bt_token"));
  expect(token, "bt_token should not be set after a failed login").toBeNull();
});
