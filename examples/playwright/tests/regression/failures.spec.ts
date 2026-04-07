import { test, expect } from "@playwright/test";

test.describe("Intentional Failures", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#login");
  });

  test("should fail - element does not exist", async ({ page }) => {
    await expect(page.getByTestId("nonexistent-button")).toBeVisible({ timeout: 2000 });
  });

  test("should fail - wrong text content", async ({ page }) => {
    await expect(page.getByTestId("login-button")).toContainText("Submit Form", { timeout: 2000 });
  });

  test("should fail - login then wrong assertion", async ({ page }) => {
    await page.getByTestId("email-input").fill("admin@test.com");
    await page.getByTestId("password-input").fill("password");
    await page.getByTestId("login-button").click();
    await expect(page.getByTestId("login-success")).toBeVisible();
    await expect(page.getByTestId("todos-page")).toBeVisible();
    await page.getByTestId("todo-input").fill("Buy milk");
    await page.getByTestId("todo-input").press("Enter");
    await expect(page.getByTestId("todo-list")).toContainText("Buy milk");
    await expect(page.getByTestId("todo-count")).toContainText("1 item");
    // This will fail
    await expect(page.getByTestId("todo-count")).toContainText("99 items", { timeout: 2000 });
  });
});
