import { test, expect } from "@playwright/test";

test.describe("Users Table", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#users");
  });

  test("should display all users", async ({ page }) => {
    await expect(page.getByTestId("users-body").locator("tr")).toHaveCount(5);
  });

  test("should be sorted by name ascending by default", async ({ page }) => {
    await expect(page.getByTestId("users-body").locator("tr").first()).toContainText("Alice Johnson");
    await expect(page.getByTestId("users-body").locator("tr").last()).toContainText("Eve Davis");
  });

  test("should sort by name descending on click", async ({ page }) => {
    await page.getByTestId("sort-name").click();
    await expect(page.getByTestId("users-body").locator("tr").first()).toContainText("Eve Davis");
    await expect(page.getByTestId("users-body").locator("tr").last()).toContainText("Alice Johnson");
  });

  test("should sort by email", async ({ page }) => {
    await page.getByTestId("sort-email").click();
    await expect(page.getByTestId("users-body").locator("tr").first()).toContainText("alice@test.com");
  });

  test("should sort by role", async ({ page }) => {
    await page.getByTestId("sort-role").click();
    await expect(page.getByTestId("users-body").locator("tr").first()).toContainText("Admin");
  });

  test("should open delete confirmation modal", async ({ page }) => {
    await page.getByTestId("delete-alice@test.com").click();
    await expect(page.getByTestId("delete-modal")).toBeVisible();
    await expect(page.locator("#delete-user-name")).toContainText("Alice Johnson");
  });

  test("should cancel delete", async ({ page }) => {
    await page.getByTestId("delete-alice@test.com").click();
    await page.getByTestId("cancel-delete").click();
    await expect(page.getByTestId("delete-modal")).not.toBeVisible();
    await expect(page.getByTestId("users-body").locator("tr")).toHaveCount(5);
  });

  test("should confirm delete and remove user", async ({ page }) => {
    await page.getByTestId("delete-bob@test.com").click();
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("users-body").locator("tr")).toHaveCount(4);
    await expect(page.getByTestId("users-body")).not.toContainText("Bob Smith");
  });
});
