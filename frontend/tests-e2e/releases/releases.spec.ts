import { expect, test } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

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
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test.beforeEach(async ({ page }) => {
    await page.goto("/releases");
    await expect(page.locator(".release-grid").first()).toBeVisible({ timeout: 10_000 });
  });

  test("renders header + all three seeded releases as cards", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Releases" })).toBeVisible();

    // The three seeded releases should each render as a card. The
    // .release-card anchor href is the contract: /releases/<id>.
    const cards = page.locator(".release-card");
    const count = await cards.count();
    expect(count, "expected 3 seeded releases for Acme").toBeGreaterThanOrEqual(3);

    // Versions visible on the cards.
    const versions = await cards.locator(".version").evaluateAll((els) =>
      els.map((e) => e.textContent?.trim() ?? ""),
    );
    expect(versions).toEqual(expect.arrayContaining(["v2.4.0", "v2.5.0", "v2.3.0"]));
  });

  test("each card shows the right status pill", async ({ page }) => {
    const card = (version: string) =>
      page.locator(".release-card", { has: page.locator(".version", { hasText: version }) }).first();

    // Status text in the seed: 'in_progress' | 'draft' | 'signed_off'.
    // The route renders status-{value} class and text replaces _ with space.
    await expect(card("v2.4.0").locator(".status")).toHaveText(/in progress/i);
    await expect(card("v2.5.0").locator(".status")).toHaveText(/draft/i);
    await expect(card("v2.3.0").locator(".status")).toHaveText(/signed off/i);
  });

  test("v2.4.0 card shows the 6-item checklist progress + name", async ({ page }) => {
    const v240 = page.locator(".release-card", {
      has: page.locator(".version", { hasText: "v2.4.0" }),
    });

    // The seed inserts 6 checklist items. The progress label reads
    // "<checked>/<total> checklist items"; we don't pin <checked>
    // because the toggle tests in release-detail.spec.ts may have
    // mutated the checked count by the time this assertion runs.
    await expect(v240.locator(".progress-label")).toHaveText(/\d+\/6 checklist items/);

    // The release's friendly name "Q2 launch" is on the card.
    await expect(v240.locator(".name")).toHaveText("Q2 launch");
  });

  test("v2.3.0 (signed_off) card shows the sign-off banner", async ({ page }) => {
    const v230 = page.locator(".release-card", {
      has: page.locator(".version", { hasText: "v2.3.0" }),
    });

    // The signed-off card shows "Signed off by <email> · <date>".
    await expect(v230.locator(".signed")).toHaveText(/Signed off by .* · .*/);
  });

  test("clicking a release card navigates to /releases/<id>", async ({ page }) => {
    const v240Card = page.locator(".release-card", {
      has: page.locator(".version", { hasText: "v2.4.0" }),
    });
    const href = await v240Card.getAttribute("href");
    expect(href).toMatch(/^\/releases\/\d+$/);

    await v240Card.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`), { timeout: 10_000 });
    // Release detail header should land.
    await expect(page.getByRole("heading", { name: "v2.4.0" })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("admin can create a new release via the inline form", async ({ page }) => {
    await page.getByRole("button", { name: /New release/ }).click();

    // The create-card form appears with version + name + target + desc.
    const form = page.locator(".create-card");
    await expect(form).toBeVisible();

    const newVersion = `e2e-${Date.now()}`;
    await form.locator('input[placeholder*="v1.2.0"]').fill(newVersion);
    await form.getByRole("button", { name: /^Create$/ }).click();

    // Toast surfaces; the form closes; the new card appears in the grid.
    await expect(form).toBeHidden({ timeout: 5_000 });
    await expect(
      page.locator(".release-card", {
        has: page.locator(".version", { hasText: newVersion }),
      }),
    ).toBeVisible({ timeout: 5_000 });
  });
});
