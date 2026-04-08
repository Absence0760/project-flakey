import { test, expect } from "@playwright/test";

test.describe("Login", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#login");
  });

  test("should show the login form", async ({ page }) => {
    await expect(page.getByTestId("login-form")).toBeVisible();
  });

  test("should login with valid credentials", async ({ page }) => {
    await page.getByTestId("email-input").fill("admin@test.com");
    await page.getByTestId("password-input").fill("password");
    await page.getByTestId("login-button").click();
    await expect(page.getByTestId("login-success")).toBeVisible();
  });

  test("should show error with invalid credentials", async ({ page }) => {
    await page.getByTestId("email-input").fill("wrong@test.com");
    await page.getByTestId("password-input").fill("wrong");
    await page.getByTestId("login-button").click();
    await expect(page.getByTestId("login-error")).toBeVisible();
  });
});
