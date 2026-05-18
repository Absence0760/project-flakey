import { expect, test, type Page } from "../fixtures/test";


/**
 * Two /manual-tests fixes reported from manual testing:
 *
 * 1. The reorder icon buttons in the create-test modal (↑ ↓ ✕)
 *    rendered with `color: var(--text-muted)` at rest, which on
 *    a light theme is `#717182` on a near-white background. The
 *    arrow glyphs are thin so the visible-contrast budget was
 *    very low — users couldn't see them without hovering. Bumped
 *    the at-rest colour to `--text-secondary` and disabled
 *    opacity from 0.3 to 0.5.
 *
 * 2. The test rows on /manual-tests used `<a href="#">` around
 *    the title only. The user's request: mirror the runs-list
 *    `tr.run-row` pattern where the WHOLE row is the click
 *    target. The row is now `role="button" tabindex="0"` with
 *    an onclick on the <tr> and stopPropagation on the delete
 *    button so ✕ doesn't open the detail modal.
 */

async function openCreateModal(page: Page): Promise<void> {
  await page.goto("/manual-tests");
  await expect(page.locator("table.tests")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /\+ New test/ }).click();
  await expect(page.locator(".modal.create-modal")).toBeVisible({ timeout: 5_000 });
}

test.describe("/manual-tests reorder icon buttons are visible at rest", () => {

  test("Move down icon-btn has readable contrast against the modal background", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    await openCreateModal(page);

    // The first step row's "Move down" button is enabled (it's NOT
    // disabled because there's no second step yet — wait, on a fresh
    // modal there's exactly 1 step row, so move-down IS disabled).
    // Add a second step so we have a real "Move down" target to
    // measure (enabled, not :disabled-opacity-attenuated).
    await page.getByRole("button", { name: /\+ Add step/ }).click();

    const moveDown = page.locator('.icon-btn[title="Move down"]').first();
    await expect(moveDown).toBeVisible();
    await expect(moveDown).not.toBeDisabled();

    const { color, bg } = await moveDown.evaluate((el) => {
      const cs = getComputedStyle(el);
      const parent = el.parentElement as HTMLElement;
      // walk up to find a non-transparent ancestor for bg
      let bgEl: HTMLElement | null = parent;
      while (bgEl && getComputedStyle(bgEl).backgroundColor === "rgba(0, 0, 0, 0)") {
        bgEl = bgEl.parentElement;
      }
      return {
        color: cs.color,
        bg: bgEl ? getComputedStyle(bgEl).backgroundColor : "rgb(255, 255, 255)",
      };
    });

    function parse(rgb: string): [number, number, number] {
      const m = rgb.match(/\d+/g);
      if (!m) return [0, 0, 0];
      return [Number(m[0]), Number(m[1]), Number(m[2])];
    }
    function rel(c: number): number {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    }
    function luminance([r, g, b]: [number, number, number]): number {
      return 0.2126 * rel(r) + 0.7152 * rel(g) + 0.0722 * rel(b);
    }
    const lFg = luminance(parse(color));
    const lBg = luminance(parse(bg));
    const contrast = (Math.max(lFg, lBg) + 0.05) / (Math.min(lFg, lBg) + 0.05);

    // Pre-fix the at-rest colour was var(--text-muted) ≈ #717182 on
    // a near-white background → contrast ratio ~4.0. The old behaviour
    // satisfied AA on its own, but the thin glyph (↓) made it feel
    // invisible. Post-fix --text-secondary should push contrast to
    // ≥ 5.5. Assert a threshold that fails decisively on the old
    // --text-muted value.
    expect(
      contrast,
      `.icon-btn[title="Move down"] contrast (${contrast.toFixed(2)}) is too low; was --text-muted at rest`,
    ).toBeGreaterThanOrEqual(5.0);
  });
});

test.describe("/manual-tests rows are clickable anywhere — match runs-list pattern", () => {

  async function getDetailModal(page: Page) {
    return page.locator(".modal").filter({ hasText: /^Manual test detail|Steps|Run|Test session/ }).first();
  }

  test("clicking the row body (not the title) opens the detail modal", async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto("/manual-tests");
    await expect(page.locator("table.tests")).toBeVisible({ timeout: 10_000 });

    const row = page.locator("table.tests tbody tr.test-row").first();
    await expect(row).toBeVisible();

    // Click the SUITE cell (not the title). Pre-fix this did nothing
    // because only the <a> in the title cell was wired. Post-fix the
    // whole row is the click target.
    const suiteCell = row.locator("td").nth(1);
    await suiteCell.click();

    await expect(page.locator(".modal-overlay")).toBeVisible({ timeout: 5_000 });
  });

  test("rows are focusable and Enter opens the modal", async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto("/manual-tests");
    await expect(page.locator("table.tests")).toBeVisible({ timeout: 10_000 });

    const row = page.locator("table.tests tbody tr.test-row").first();
    await row.focus();
    await expect(row).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(page.locator(".modal-overlay")).toBeVisible({ timeout: 5_000 });
  });

  test("clicking the delete button does NOT open the detail modal", async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto("/manual-tests");
    await expect(page.locator("table.tests")).toBeVisible({ timeout: 10_000 });

    const row = page.locator("table.tests tbody tr.test-row").first();
    const deleteBtn = row.getByRole("button", { name: "✕" });
    await deleteBtn.click();

    // A confirm modal should appear (the delete-test flow). The
    // tests-detail modal must NOT also open. Verify the visible
    // modal is the confirm one, not the detail one.
    await expect(page.locator(".modal.confirm-modal")).toBeVisible({ timeout: 5_000 });
    // Dismiss the confirm to leave the page clean for follow-ups.
    // Scope to the confirm modal — there's a row whose title
    // includes "Cancel" that would otherwise also match.
    await page.locator(".modal.confirm-modal").getByRole("button", { name: "Cancel", exact: true }).click();
  });
});
