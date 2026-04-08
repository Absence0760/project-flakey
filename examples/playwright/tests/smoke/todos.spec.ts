import { test, expect } from "@playwright/test";

test.describe("Todos", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#todos");
  });

  test("should add a new todo", async ({ page }) => {
    await page.getByTestId("todo-input").fill("Buy groceries");
    await page.getByTestId("add-todo").click();
    await expect(page.getByTestId("todo-list")).toContainText("Buy groceries");
    await expect(page.getByTestId("todo-count")).toContainText("1 item");
  });

  test("should add a todo with Enter key", async ({ page }) => {
    await page.getByTestId("todo-input").fill("Walk the dog");
    await page.getByTestId("todo-input").press("Enter");
    await expect(page.getByTestId("todo-list")).toContainText("Walk the dog");
  });

  test("should mark a todo as completed", async ({ page }) => {
    await page.getByTestId("todo-input").fill("Read a book");
    await page.getByTestId("todo-input").press("Enter");
    await page.getByTestId("todo-list").locator('input[type="checkbox"]').first().click();
    await expect(page.locator(".todo-item.done")).toBeVisible();
  });

  test("should delete a todo", async ({ page }) => {
    await page.getByTestId("todo-input").fill("Temporary");
    await page.getByTestId("todo-input").press("Enter");
    await page.locator(".delete-btn").first().click();
    await expect(page.getByTestId("todo-list")).not.toContainText("Temporary");
  });

  test("should filter active todos", async ({ page }) => {
    await page.getByTestId("todo-input").fill("Active");
    await page.getByTestId("todo-input").press("Enter");
    await page.getByTestId("todo-input").fill("Done");
    await page.getByTestId("todo-input").press("Enter");
    await page.getByTestId("todo-list").locator('input[type="checkbox"]').last().click();
    await page.getByTestId("filter-active").click();
    await expect(page.locator(".todo-item")).toHaveCount(1);
  });
});
