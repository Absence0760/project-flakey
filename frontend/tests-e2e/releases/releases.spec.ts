import { expect, test } from "../fixtures/test";


/**
 * /releases — release-list surface.
 *
 * Seed creates three releases for Acme:
 *   - v2.4.0 (in_progress)  — checklist + sessions, the demo-rich one.
 *   - v2.5.0 (draft)        — empty checklist, no links.
 *   - v2.3.0 (signed_off)   — completed, post-shipment state.
 *
 * Each card surfaces version, status pill, checklist progress,
 * sign-off info or target date.
 */

test.describe("/releases", () => {

  test.beforeEach(async ({ page }) => {
    await page.goto("/releases");
    await expect(page.locator(".release-grid").first()).toBeVisible({ timeout: 10_000 });
  });

  // Each tenant carries 55+ releases (3 hero + 52 bulk pagination
  // coverage), and other specs that create-but-don't-clean-up e2e-*
  // releases accumulate state across runs. Use the page's search box
  // to scope the visible cards to a single version — this makes the
  // assertions independent of the 50-per-page boundary regardless of
  // how much test-leftover data lives in the tenant.
  async function findCard(page: import("../fixtures/test").Page, version: string) {
    await page.getByPlaceholder("Search version or name…").fill(version);
    const card = page.locator(".release-card", {
      has: page.locator(".version", { hasText: version }),
    }).first();
    await expect(card).toBeVisible({ timeout: 5_000 });
    return card;
  }

  test("renders the subtitle + all three seeded releases as cards", async ({ page }) => {
    // The page intentionally has no <h1> — the sidebar nav + URL
    // label the page (see /releases/+page.svelte:259). The subtitle
    // is the next-most-stable copy anchor.
    await expect(page.locator(".subtitle")).toContainText(/release/i);

    // The three seeded releases should each surface when filtered by
    // their version. Use findCard's search-then-assert so the test
    // doesn't depend on which page of the paginated grid they sit on.
    await findCard(page, "v2.4.0");
    await findCard(page, "v2.5.0");
    await findCard(page, "v2.3.0");
  });

  test("each card shows the right status pill", async ({ page }) => {
    // Status text in the seed: 'in_progress' | 'draft' | 'signed_off'.
    // The route renders status-{value} class and text replaces _ with space.
    await expect((await findCard(page, "v2.4.0")).locator(".status")).toHaveText(/in progress/i);
    await expect((await findCard(page, "v2.5.0")).locator(".status")).toHaveText(/draft/i);
    await expect((await findCard(page, "v2.3.0")).locator(".status")).toHaveText(/signed off/i);
  });

  test("v2.4.0 card shows the 6-item checklist progress + name", async ({ page }) => {
    const v240 = await findCard(page, "v2.4.0");

    // The seed inserts 6 checklist items. The progress label reads
    // "<checked>/<total> · <pct>%"; we don't pin <checked> because the
    // toggle tests in release-detail.spec.ts may have mutated the
    // checked count by the time this assertion runs.
    await expect(v240.locator(".progress-label")).toHaveText(/\d+\/6\s*·\s*\d+%/);

    // The release's friendly name "Q2 launch" is on the card.
    await expect(v240.locator(".name")).toHaveText("Q2 launch");
  });

  test("v2.3.0 (signed_off) card shows the sign-off banner", async ({ page }) => {
    const v230 = await findCard(page, "v2.3.0");

    // The signed-off card shows "✓ Signed off <date> · <email>".
    // Match both the leading checkmark + the two-part rendering.
    await expect(v230.locator(".signed")).toHaveText(/Signed off .* · .*/);
  });

  test("clicking a release card navigates to /releases/<id>", async ({ page }) => {
    const v240Card = await findCard(page, "v2.4.0");
    const href = await v240Card.getAttribute("href");
    expect(href).toMatch(/^\/releases\/\d+$/);

    await v240Card.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`), { timeout: 10_000 });
    // Release detail header should land.
    await expect(page.getByRole("heading", { name: "v2.4.0" })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("admin can create a new release via the modal form", async ({ page }) => {
    // The "+ New release" button now opens a modal overlay (it was
    // an inline .create-card in an earlier design). Click the button,
    // fill the version field, submit, assert the new card appears.
    await page.getByRole("button", { name: /\+ New release/ }).click();

    const modal = page.locator(".modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(modal.getByRole("heading", { name: "New release" })).toBeVisible();

    const newVersion = `e2e-${Date.now()}`;
    await modal.locator('input[placeholder*="v1.2.0"]').fill(newVersion);
    await modal.getByRole("button", { name: /^Create release$/ }).click();

    // Modal dismisses; new release lands on the server. The release
    // grid paginates at 50 cards and accumulates seeded + prior-run
    // releases in dev DB, so the just-created card may not be on
    // page 1. Filter to it by version using the search box (which
    // resets pagination on input — see +page.svelte's $effect).
    await expect(modal).toBeHidden({ timeout: 5_000 });
    await page.getByPlaceholder("Search version or name…").fill(newVersion);
    const newCard = page.locator(".release-card", {
      has: page.locator(".version", { hasText: newVersion }),
    });
    await expect(newCard).toBeVisible({ timeout: 5_000 });

    // Cleanup: DELETE the release we just created so re-runs of this
    // spec against the same tenant don't accumulate e2e-* releases.
    // Without this, each run leaves one more leftover, eventually
    // pushing v2.5.0 past the 50-per-page boundary and breaking the
    // "each card shows the right status pill" test on later runs.
    const newId = await newCard.first().getAttribute("href").then((h) => {
      const m = h?.match(/\/releases\/(\d+)/);
      return m ? Number(m[1]) : null;
    });
    if (newId !== null) {
      const token = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
      await page.request.delete(`http://localhost:3000/releases/${newId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  });
});
