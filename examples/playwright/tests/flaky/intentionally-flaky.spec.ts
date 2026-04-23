/**
 * INTENTIONALLY FLAKY TESTS — for demonstrating Better Testing flaky detection.
 *
 * These tests randomly fail ~30% of the time by design. They are NOT included
 * in test:smoke / test:sanity / test:regression / test:all. Run them explicitly
 * with: pnpm test:flaky
 *
 * Purpose: show the flaky-detection dashboard catching tests that sometimes
 * pass and sometimes fail across CI runs, without a code defect being present.
 */

import { test, expect } from "@playwright/test";

function maybeFail(failRate = 0.3): void {
  if (Math.random() < failRate) {
    throw new Error(`[intentional flake] random failure triggered (p=${failRate})`);
  }
}

test.describe("Intentionally flaky suite", () => {
  test("flaky — random timing assertion", async ({ page }) => {
    await page.goto("/#todos");

    // Simulate a race condition by randomly deciding the count is wrong
    maybeFail(0.3);

    const count = await page.getByTestId("todo-count").textContent();
    expect(count).toContain("0 items");
  });

  test("flaky — intermittent element visibility", async ({ page }) => {
    await page.goto("/#login");

    // Real code would wait for a slow element; here we simulate ~30% failure
    maybeFail(0.3);

    await expect(page.getByTestId("login-form")).toBeVisible();
  });

  test("flaky — non-deterministic data check", async ({ page }) => {
    await page.goto("/#todos");

    await page.getByTestId("todo-input").fill("Flaky item");
    await page.getByTestId("todo-input").press("Enter");

    // Simulate a race where the list occasionally appears empty
    maybeFail(0.35);

    await expect(page.getByTestId("todo-list")).toContainText("Flaky item");
  });
});
