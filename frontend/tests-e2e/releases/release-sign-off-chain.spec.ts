import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * /releases — full sign-off chain end-to-end.
 *
 * The flow we drive:
 *   1. Create a NEW release via API (so we don't mutate the seed
 *      releases that other tests rely on)
 *   2. Navigate to its detail page
 *   3. Confirm the default checklist (6 items, 5 required) was
 *      auto-inserted by the route's POST /releases handler
 *   4. Check every required item via the UI
 *   5. The "Sign off release" CTA enables; click it
 *   6. The route flips status to signed_off — header banner and
 *      Mark released CTA replace the Sign off CTA
 *   7. Navigate back to the /releases list — the new release card
 *      shows the "signed off" status pill
 *
 * This is the single most-load-bearing chain on the release surface
 * — a regression at any link breaks the whole shipping workflow.
 */

async function createRelease(page: Page): Promise<{ id: number; version: string }> {
  await page.goto("/dashboard");
  const token = await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
  const version = `e2e-signoff-${Date.now().toString(36)}`;
  // Pass an explicit checklist (no auto-rules). DEFAULT_CHECKLIST
  // includes 2 auto-rule items that evaluate against linked runs/tests
  // and stay locked-blocked unless the org has the matching state.
  // For the sign-off chain test we want plain togglable items only.
  const res = await page.request.post("http://localhost:3000/releases", {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: {
      version,
      name: "e2e sign-off chain",
      items: [
        { label: "QA review complete", required: true },
        { label: "Release notes drafted", required: true },
        { label: "Stakeholders notified", required: true },
        { label: "Documentation updated", required: false },
      ],
    },
  });
  expect(res.status(), "POST /releases should return 2xx").toBeLessThan(400);
  const body = await res.json();
  expect(body.id).toBeTruthy();
  return { id: body.id, version };
}

test.describe("release sign-off chain", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("create → check all required → sign off → status flips → list view reflects it", async ({
    page,
  }) => {
    const { id, version } = await createRelease(page);

    // Land on the detail page.
    await page.goto(`/releases/${id}`);
    await expect(page.getByRole("heading", { name: version })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".release-header .status")).toHaveText(/draft/i);

    // We POSTed a 4-item custom checklist (no auto-rules).
    const checklistSection = page.locator("section", {
      has: page.getByRole("heading", { name: "Checklist" }),
    });
    const items = checklistSection.locator("ul.items > li");
    await expect(items).toHaveCount(4);

    // Sign-off button is initially DISABLED — required items unchecked.
    const signOffBtn = page.getByRole("button", { name: /Sign off release/ });
    await expect(signOffBtn).toBeDisabled();

    // Check every required item. Required items have a `.req` pill.
    // We check ALL items (required-only would break if our seed shifts).
    const checkboxes = checklistSection.locator(
      'ul.items > li input[type="checkbox"]:not([disabled])',
    );
    const cbCount = await checkboxes.count();
    for (let i = 0; i < cbCount; i++) {
      const cb = checkboxes.nth(i);
      if (!(await cb.isChecked())) await cb.check();
    }

    // Sign-off CTA enables; click it.
    await expect(signOffBtn).toBeEnabled({ timeout: 5_000 });
    await signOffBtn.click();

    // Header status pill flips to "signed off"; the actions section
    // shows the post-sign-off banner and a "Mark released" CTA.
    await expect(page.locator(".release-header .status")).toHaveText(/signed off/i, {
      timeout: 5_000,
    });
    await expect(page.locator("section.actions-section .signed-off")).toBeVisible();
    await expect(page.getByRole("button", { name: /Sign off release/ })).toHaveCount(0);
    await expect(
      page.locator("section.actions-section").getByRole("button", { name: /Mark released/ }),
    ).toBeVisible();

    // Navigate back to the /releases list — the NEW release card
    // surfaces with the "signed off" status pill. List paginates at
    // 50; filter via search to surface this specific version.
    await page.goto("/releases");
    await page.getByPlaceholder("Search version or name…").fill(version);
    const card = page.locator(".release-card", {
      has: page.locator(".version", { hasText: version }),
    }).first();
    await expect(card).toBeVisible({ timeout: 5_000 });
    await expect(card.locator(".status")).toHaveText(/signed off/i);
  });
});
