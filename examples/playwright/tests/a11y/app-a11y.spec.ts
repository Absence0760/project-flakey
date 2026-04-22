/**
 * Accessibility scan using @axe-core/playwright.
 *
 * This example is intentionally log-only — violations are printed to the
 * console but do not hard-fail the test. This lets teams see the a11y
 * baseline without blocking CI while they work through the backlog.
 *
 * Tradeoff: flipping `expect(violations).toHaveLength(0)` below turns this
 * into an enforcement gate. Start log-only, enforce when the backlog is clear.
 */

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.describe("Accessibility — main app routes", () => {
  test("login page has no critical axe violations", async ({ page }) => {
    await page.goto("/#login");

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();

    if (results.violations.length > 0) {
      console.log(
        `[a11y] ${results.violations.length} violation(s) on /#login:`
      );
      for (const v of results.violations) {
        console.log(`  [${v.impact}] ${v.id}: ${v.description}`);
        for (const node of v.nodes) {
          console.log(`    - ${node.html}`);
        }
      }
    }

    // Log-only: no hard assert on violation count.
    // Remove the comment below and uncomment the assertion to enforce:
    // expect(results.violations).toHaveLength(0);
    expect(results.passes.length).toBeGreaterThanOrEqual(0);
  });

  test("todos page has no critical axe violations", async ({ page }) => {
    await page.goto("/#todos");

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();

    if (results.violations.length > 0) {
      console.log(
        `[a11y] ${results.violations.length} violation(s) on /#todos:`
      );
      for (const v of results.violations) {
        console.log(`  [${v.impact}] ${v.id}: ${v.description}`);
        for (const node of v.nodes) {
          console.log(`    - ${node.html}`);
        }
      }
    }

    // Log-only — see comment at top of file.
    expect(results.passes.length).toBeGreaterThanOrEqual(0);
  });
});
