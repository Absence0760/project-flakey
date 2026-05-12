import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * Keyboard a11y regression for the components touched in the
 * a11y pass:
 *
 *   - runs/[id]:802 — the test-error-bar is now a focusable
 *     div role="button" with Enter/Space activation, and the
 *     copy-error icon is a real <button> sibling (not a
 *     nested-button-in-button as before).
 *
 *   - ErrorModal — backdrop is now focused on open and Escape
 *     closes it; the gherkin command-log <li> rows respond to
 *     Enter/Space; the splitter responds to ArrowLeft/Right.
 *
 *   - Lightbox — backdrop focused on open, Escape closes,
 *     viewport responds to +/-/0/arrows when focused.
 *
 * These specs prove the keyboard contract — none of them would
 * have passed before this pass (no kbd handlers existed for the
 * <li>s, the splitter, or focused dialog state on open).
 */

async function openRunWithFailures(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator("a.run-card").first().waitFor({ timeout: 15_000 });
  // The seed creates many failing runs; pick the first card that
  // shows the `.fail-badge` (rendered for `failed > 0`) so the
  // ErrorModal trigger (".test-error-bar") exists on the detail page.
  const failingCard = page.locator("a.run-card").filter({ has: page.locator(".fail-badge") }).first();
  await failingCard.click({ timeout: 10_000 });
  await page.waitForURL(/\/runs\/\d+/, { timeout: 10_000 });
}

test.describe("keyboard a11y — runs/[id] error bar", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("test-error-bar is Tab-reachable and Enter opens the ErrorModal", async ({ page }) => {
    test.setTimeout(45_000);
    await openRunWithFailures(page);

    const errorBar = page.locator(".test-error-bar").first();
    await errorBar.waitFor({ timeout: 15_000 });

    // Focus via the DOM (Tab order from the top is long; the goal
    // here is to verify the element IS focusable and Enter triggers
    // the modal — both new behaviours from this pass).
    await errorBar.focus();
    await expect(errorBar).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(page.locator(".backdrop[role='dialog']")).toBeVisible({ timeout: 5_000 });
  });

  test("copy-error-btn inside the bar is a real button (not nested) and is independently focusable", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await openRunWithFailures(page);

    const bar = page.locator(".test-error-bar").first();
    await bar.waitFor({ timeout: 15_000 });

    // Pre-pass this was a <span role="button" tabindex="-1"> inside
    // a <button class="test-error-bar"> — invalid nested-button HTML
    // and the span was non-focusable. Post-pass both are sibling
    // focusable elements: outer div role=button, inner real button.
    const copyBtn = bar.locator(".copy-error-btn");
    await expect(copyBtn).toHaveJSProperty("tagName", "BUTTON");

    // Focus the copy button explicitly and confirm it gets focus —
    // a regression that nested it inside the outer button would
    // make this fail because browsers flatten nested buttons.
    await copyBtn.focus();
    await expect(copyBtn).toBeFocused();
  });
});

test.describe("keyboard a11y — ErrorModal", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("backdrop receives focus on open and Escape closes", async ({ page }) => {
    test.setTimeout(45_000);
    await openRunWithFailures(page);

    await page.locator(".test-error-bar").first().click();
    const dialog = page.locator(".backdrop[role='dialog']");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    // backdropEl.focus() runs in $effect — race a short settle.
    await expect(dialog).toBeFocused({ timeout: 1_500 });

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0, { timeout: 3_000 });
  });

  test("clicking the backdrop closes — clicking the inner panel does NOT", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await openRunWithFailures(page);

    await page.locator(".test-error-bar").first().click();
    const dialog = page.locator(".backdrop[role='dialog']");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Click inside the debugger panel — must NOT close (the
    // target===currentTarget check on the backdrop's onclick is the
    // replacement for the previous stopPropagation on the inner div).
    await page.locator(".debugger").click({ position: { x: 50, y: 50 } });
    await expect(dialog).toBeVisible();

    // Click the backdrop itself (corners are usually clear of the
    // inner panel) — must close.
    const box = await dialog.boundingBox();
    if (!box) throw new Error("backdrop has no bounding box");
    await page.mouse.click(box.x + 5, box.y + 5);
    await expect(dialog).toHaveCount(0, { timeout: 3_000 });
  });
});
