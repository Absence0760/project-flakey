import { test, expect } from "@playwright/test";

test.describe("Form", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#form");
  });

  test("should display the form with default values", async ({ page }) => {
    await expect(page.getByTestId("create-form")).toBeVisible();
    await expect(page.getByTestId("item-priority")).toHaveValue("medium");
  });

  test("should submit with all fields", async ({ page }) => {
    await page.getByTestId("item-name").fill("New feature");
    await page.getByTestId("item-category").selectOption("feature");
    await page.getByTestId("item-priority").selectOption("high");
    await page.getByTestId("item-description").fill("A great feature");
    await page.getByTestId("item-urgent").check();
    await page.getByTestId("submit-form").click();
    await expect(page.getByTestId("form-result")).toBeVisible();
    await expect(page.getByTestId("form-result")).toContainText("New feature");
  });

  test("should submit with only required fields", async ({ page }) => {
    await page.getByTestId("item-name").fill("Minimal");
    await page.getByTestId("submit-form").click();
    await expect(page.getByTestId("form-result")).toContainText("Minimal");
  });

  test("should reset the form", async ({ page }) => {
    await page.getByTestId("item-name").fill("Something");
    await page.getByTestId("item-urgent").check();
    await page.getByTestId("reset-form").click();
    await expect(page.getByTestId("item-name")).toHaveValue("");
    await expect(page.getByTestId("item-urgent")).not.toBeChecked();
  });
});
