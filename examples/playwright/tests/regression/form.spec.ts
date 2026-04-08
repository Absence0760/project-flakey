import { test, expect } from "@playwright/test";

test.describe("Form", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#form");
  });

  test("should display the form", async ({ page }) => {
    await expect(page.getByTestId("create-form")).toBeVisible();
    await expect(page.getByTestId("item-priority")).toHaveValue("medium");
  });

  test("should submit the form and show result", async ({ page }) => {
    await page.getByTestId("item-name").fill("Fix login bug");
    await page.getByTestId("item-category").selectOption("bug");
    await page.getByTestId("item-priority").selectOption("high");
    await page.getByTestId("item-description").fill("Login fails on Safari");
    await page.getByTestId("item-urgent").check();
    await page.getByTestId("submit-form").click();
    await expect(page.getByTestId("form-result")).toBeVisible();
    await expect(page.getByTestId("form-result")).toContainText("Fix login bug");
    await expect(page.getByTestId("form-result")).toContainText("URGENT");
  });

  test("should reset the form", async ({ page }) => {
    await page.getByTestId("item-name").fill("Something");
    await page.getByTestId("item-category").selectOption("feature");
    await page.getByTestId("item-urgent").check();
    await page.getByTestId("reset-form").click();
    await expect(page.getByTestId("item-name")).toHaveValue("");
    await expect(page.getByTestId("item-category")).toHaveValue("");
    await expect(page.getByTestId("item-urgent")).not.toBeChecked();
  });

  test("should require the name field", async ({ page }) => {
    await page.getByTestId("submit-form").click();
    await expect(page.getByTestId("form-result")).not.toBeVisible();
  });

  test("should submit without optional fields", async ({ page }) => {
    await page.getByTestId("item-name").fill("Minimal item");
    await page.getByTestId("submit-form").click();
    await expect(page.getByTestId("form-result")).toContainText("Minimal item");
    await expect(page.getByTestId("form-result")).toContainText("uncategorized");
  });
});
