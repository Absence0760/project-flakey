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
  });

  test("should sort by name descending on click", async ({ page }) => {
    await page.getByTestId("sort-name").click();
    await expect(page.getByTestId("users-body").locator("tr").first()).toContainText("Eve Davis");
  });

  test("should open and cancel delete modal", async ({ page }) => {
    await page.getByTestId("delete-alice@test.com").click();
    await expect(page.getByTestId("delete-modal")).toBeVisible();
    await page.getByTestId("cancel-delete").click();
    await expect(page.getByTestId("delete-modal")).not.toBeVisible();
    await expect(page.getByTestId("users-body").locator("tr")).toHaveCount(5);
  });

  test("should delete a user", async ({ page }) => {
    await page.getByTestId("delete-bob@test.com").click();
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("users-body").locator("tr")).toHaveCount(4);
  });
});
