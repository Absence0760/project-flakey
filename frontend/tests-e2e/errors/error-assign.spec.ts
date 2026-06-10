import { expect, test } from "../fixtures/test";

/**
 * /errors — assign an owner to an error group from the detail pane and verify
 * it round-trips the server.
 *
 * The detail pane gained an "Owner" section backed by the shared
 * AssigneePicker (inputs/AssigneePicker.svelte): a chip showing the current
 * assignee with an invisible <select aria-label="Assign owner"> overlaid for
 * picking. Members load lazily on focus (GET /orgs/:id/members) and the choice
 * POSTs to /errors/:fingerprint/assign.
 *
 * We don't pin a fingerprint — the seed aggregates failed tests into error
 * groups; we drive whichever row sorts to the top, capture its message, and
 * re-find it by message after reload. We assign by selecting the first real
 * member option (the signed-in user is always a member), assert the
 * "Unassigned" placeholder is replaced by a chip, and that the select's value
 * survives a reload (proving the write hit the server). Cleanup un-assigns.
 */

test.describe("/errors — assign an owner", () => {
  test("assign a member, chip appears, persists across reload, then un-assign", async ({
    page,
  }) => {
    await page.goto("/errors");
    await expect(page.locator("button.error-item").first()).toBeVisible({ timeout: 10_000 });

    const target = page.locator("button.error-item").first();
    const targetMessage = (await target.locator(".error-msg").innerText()).trim();
    expect(targetMessage.length, "target error row must have a message").toBeGreaterThan(0);
    await target.click();

    // The Owner section's picker. Focus it so members load lazily, then wait
    // for at least one real member option beyond the "Unassigned" placeholder.
    const picker = page.getByLabel("Assign owner");
    await expect(picker).toBeVisible();
    await picker.focus();
    await expect
      .poll(async () => picker.locator("option").count(), { timeout: 5_000 })
      .toBeGreaterThan(1);

    // Pick the first real member (index 1; index 0 is "Unassigned").
    const memberValue = await picker.locator("option").nth(1).getAttribute("value");
    expect(memberValue, "a member option carries a user id").toBeTruthy();
    await picker.selectOption(memberValue!);

    // The "Unassigned" placeholder is replaced by an assignee chip.
    const ownerSection = page.locator(".detail-section", {
      has: page.getByRole("heading", { name: "Owner" }),
    });
    await expect(ownerSection.locator(".assignee-chip")).toBeVisible({ timeout: 2_000 });

    // Reload — the assignment must have hit the server. Re-select the captured
    // row and assert the picker still resolves to the chosen member.
    await page.reload();
    await expect(page.locator("button.error-item").first()).toBeVisible({ timeout: 10_000 });
    await page
      .locator("button.error-item", { has: page.locator(".error-msg", { hasText: targetMessage }) })
      .first()
      .click();

    const reloadedPicker = page.getByLabel("Assign owner");
    await expect(reloadedPicker).toHaveValue(memberValue!, { timeout: 5_000 });

    // Clean up — un-assign so re-runs start from the same baseline.
    await reloadedPicker.selectOption("");
    await expect(
      page
        .locator(".detail-section", { has: page.getByRole("heading", { name: "Owner" }) })
        .locator(".assignee-chip"),
    ).toBeHidden({ timeout: 2_000 });
  });
});
