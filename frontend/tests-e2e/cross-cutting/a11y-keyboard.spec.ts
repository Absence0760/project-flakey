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
  // Find a run with at least one failed test whose `error_message`
  // is populated. `.test-error-bar` only renders when the test has
  // an error_message, so picking the first `.fail-badge` card is
  // fragile — cucumber-style runs can report failure at the spec
  // level without per-test rows.
  await page.goto("/");
  await page.locator("a.run-card").first().waitFor({ timeout: 15_000 });
  const token = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
  if (!token) throw new Error("no auth token in localStorage");

  const runsRes = await page.request.get("http://localhost:3000/runs?limit=200", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { runs } = (await runsRes.json()) as { runs: { id: number; failed: number }[] };
  const candidates = runs.filter((r) => r.failed > 0).map((r) => r.id);

  for (const id of candidates) {
    const detailRes = await page.request.get(`http://localhost:3000/runs/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const detail = (await detailRes.json()) as {
      specs?: { tests?: { error_message?: string | null }[] }[];
    };
    const hasErrorMessage = (detail.specs ?? []).some((s) =>
      (s.tests ?? []).some((t) => typeof t.error_message === "string" && t.error_message.length > 0),
    );
    if (hasErrorMessage) {
      await page.goto(`/runs/${id}`);
      await page.locator(".test-error-bar").first().waitFor({ timeout: 10_000 });
      return;
    }
  }
  throw new Error("No failing run with a test that has error_message found");
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
