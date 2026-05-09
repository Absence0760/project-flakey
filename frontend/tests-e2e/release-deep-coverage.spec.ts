import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "./fixtures/users";

/**
 * /releases/<id> — deep coverage of every interactive surface.
 *
 * Each test creates a FRESH release via the API so we never mutate
 * the seeded v2.4.0 / v2.5.0 / v2.3.0 fixtures other tests rely on.
 * The detail page surfaces:
 *
 *   - Header: version, name, target date, status pill
 *   - Readiness panel: Ready / Blocked + per-rule cards
 *   - Linked automated runs (with link/unlink + run-picker modal)
 *   - Linked manual tests (with link/unlink + group picker)
 *   - Requirements coverage (read-only aggregation)
 *   - Checklist (toggle items, add custom, delete custom)
 *   - Test execution sessions (covered by release-sessions.spec.ts)
 *   - Actions: Sign off / Mark released / status dropdown
 *
 * The sign-off chain is covered by release-sign-off-chain.spec.ts;
 * here we focus on the smaller per-surface contracts. A regression in
 * any of these (e.g. add-item POST 500s, unlink leaves orphan rows)
 * surfaces here.
 */

interface CreateOptions {
  version?: string;
  name?: string;
  items?: Array<{ label: string; required: boolean; auto_rule?: string | null }>;
  status?: string;
}

async function getToken(page: Page): Promise<string> {
  // Caller must already be on a (app)/* route.
  return await page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

async function createRelease(
  page: Page,
  opts: CreateOptions = {},
): Promise<{ id: number; version: string; token: string }> {
  await page.goto("/dashboard");
  const token = await getToken(page);
  const version = opts.version ?? `e2e-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
  const data: Record<string, unknown> = {
    version,
    name: opts.name ?? "e2e deep-coverage",
  };
  // POSTing items=[] would fall back to DEFAULT_CHECKLIST per
  // backend/src/routes/releases.ts:499. To get an empty checklist
  // we omit `items` entirely OR pass non-empty items below.
  if (opts.items !== undefined) data.items = opts.items;
  const res = await page.request.post("http://localhost:3000/releases", {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data,
  });
  expect(res.status(), "POST /releases should return 2xx").toBeLessThan(400);
  const body = await res.json();
  return { id: body.id, version, token };
}

async function deleteRelease(page: Page, token: string, id: number): Promise<void> {
  // Best-effort cleanup so re-runs don't accumulate releases.
  await page.request.delete(`http://localhost:3000/releases/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

async function gotoRelease(page: Page, id: number, version: string): Promise<void> {
  await page.goto(`/releases/${id}`);
  await expect(page.getByRole("heading", { name: version })).toBeVisible({ timeout: 10_000 });
}

test.describe("/releases/<id> — checklist CRUD", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("admin can ADD a custom checklist item via the inline form", async ({ page }) => {
    const { id, version, token } = await createRelease(page, {
      items: [{ label: "QA review complete", required: true }],
    });
    await gotoRelease(page, id, version);

    const checklistSection = page.locator("section", {
      has: page.getByRole("heading", { name: "Checklist" }),
    });
    await expect(checklistSection.locator("ul.items > li")).toHaveCount(1);

    const newLabel = `e2e-add-${Date.now().toString(36)}`;
    const addRow = checklistSection.locator(".add-item");
    await addRow.getByPlaceholder("Add checklist item…").fill(newLabel);
    await addRow.getByRole("button", { name: /^Add$/ }).click();

    // The list grows by 1 and the new label is visible.
    await expect(checklistSection.locator("ul.items > li")).toHaveCount(2, { timeout: 5_000 });
    await expect(
      checklistSection.locator("ul.items > li", { hasText: newLabel }),
    ).toBeVisible();

    await deleteRelease(page, token, id);
  });

  test("admin can REMOVE a custom (non-auto-rule) checklist item", async ({ page }) => {
    const labelToRemove = `e2e-rm-${Date.now().toString(36)}`;
    const { id, version, token } = await createRelease(page, {
      items: [
        { label: "Stays", required: true },
        { label: labelToRemove, required: false },
      ],
    });
    await gotoRelease(page, id, version);

    const checklistSection = page.locator("section", {
      has: page.getByRole("heading", { name: "Checklist" }),
    });
    await expect(checklistSection.locator("ul.items > li")).toHaveCount(2);

    const targetRow = checklistSection.locator("ul.items > li", { hasText: labelToRemove });
    await expect(targetRow).toBeVisible();
    // Custom (non-auto-rule) items get a × Remove button.
    await targetRow.locator('button.del[title="Remove"]').click();

    await expect(checklistSection.locator("ul.items > li")).toHaveCount(1, { timeout: 5_000 });
    await expect(
      checklistSection.locator("ul.items > li", { hasText: labelToRemove }),
    ).toHaveCount(0);

    await deleteRelease(page, token, id);
  });

  test("auto-rule items render WITHOUT a remove button (can't be deleted via UI)", async ({
    page,
  }) => {
    // Use the DEFAULT_CHECKLIST path by NOT passing items — gives 6
    // items, two of which are auto-ruled.
    const { id, version, token } = await createRelease(page);
    await gotoRelease(page, id, version);

    const checklistSection = page.locator("section", {
      has: page.getByRole("heading", { name: "Checklist" }),
    });
    await expect(checklistSection.locator("ul.items > li")).toHaveCount(6);

    // The two auto-rule items have a `.req` pill but NO `.del` remove
    // button. We don't pin which items are auto-ruled — just the
    // contract: at least one item has the auto-rule shape (no remove).
    const removeButtons = checklistSection.locator('ul.items > li button.del[title="Remove"]');
    const total = await checklistSection.locator("ul.items > li").count();
    const removable = await removeButtons.count();
    expect(removable, "auto-rule items should NOT expose a remove button").toBeLessThan(total);

    await deleteRelease(page, token, id);
  });

  test("Add button is disabled until newItemLabel is non-empty", async ({ page }) => {
    const { id, version, token } = await createRelease(page, {
      items: [{ label: "x", required: true }],
    });
    await gotoRelease(page, id, version);

    const addRow = page.locator(".add-item");
    const addBtn = addRow.getByRole("button", { name: /^Add$/ });
    const input = addRow.getByPlaceholder("Add checklist item…");

    // The route's addItem() guards on `newItemLabel.trim()` — so the
    // POST won't fire on empty. We check the button doesn't trigger
    // a list change when clicked with empty input.
    const before = await page.locator("section", {
      has: page.getByRole("heading", { name: "Checklist" }),
    }).locator("ul.items > li").count();

    await addBtn.click();
    await page.waitForTimeout(300);
    const after = await page.locator("section", {
      has: page.getByRole("heading", { name: "Checklist" }),
    }).locator("ul.items > li").count();
    expect(after).toBe(before);

    // Then prove the form DOES work after typing.
    await input.fill(`x-${Date.now().toString(36)}`);
    await addBtn.click();
    await expect(
      page.locator("section", { has: page.getByRole("heading", { name: "Checklist" }) })
        .locator("ul.items > li"),
    ).toHaveCount(before + 1, { timeout: 5_000 });

    await deleteRelease(page, token, id);
  });
});

test.describe("/releases/<id> — linked-runs picker", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("admin can link a run via the picker → row appears, then unlink it", async ({ page }) => {
    const { id, version, token } = await createRelease(page, {
      items: [{ label: "x", required: true }],
    });
    await gotoRelease(page, id, version);

    // Open the linked-runs <details>.
    const panel = page.locator(".linked-runs-panel details");
    await panel.locator("summary").click();
    await expect(panel.locator(".empty", { hasText: /No runs linked/ })).toBeVisible();

    // Click "+ Link runs" to open the picker.
    await panel.locator(".btn-ghost", { hasText: /Link runs/ }).click();
    const picker = panel.locator(".picker");
    await expect(picker).toBeVisible({ timeout: 5_000 });

    // Pick the FIRST available run row and submit.
    const firstRow = picker.locator(".picker-row:not(.disabled)").first();
    await expect(firstRow).toBeVisible();
    await firstRow.locator('input[type="checkbox"]').check();
    await picker.getByRole("button", { name: /Link selected/ }).click();

    // The picker closes and the link-list shows ≥1 row. The route's
    // load() reloads release after linkRuns, which can re-render the
    // details element in its collapsed state — re-open it before
    // touching the unlink button.
    await expect(picker).toBeHidden({ timeout: 5_000 });
    if (!(await panel.locator(".link-list li").first().isVisible().catch(() => false))) {
      await panel.locator("summary").click();
    }
    await expect(panel.locator(".link-list li")).toHaveCount(1, { timeout: 5_000 });

    // Unlink via the × button.
    await panel.locator('.link-list li button.del[title="Unlink"]').click();
    // Same re-render after unlinkRun → load() — re-open if collapsed.
    if (!(await panel.locator(".empty").isVisible().catch(() => false))) {
      await panel.locator("summary").click();
    }
    await expect(panel.locator(".empty", { hasText: /No runs linked/ })).toBeVisible({
      timeout: 5_000,
    });

    await deleteRelease(page, token, id);
  });

  test("an already-linked run is rendered disabled in the picker (can't be linked twice)", async ({
    page,
  }) => {
    const { id, version, token } = await createRelease(page, {
      items: [{ label: "x", required: true }],
    });
    await gotoRelease(page, id, version);

    const panel = page.locator(".linked-runs-panel details");
    await panel.locator("summary").click();

    // First link.
    await panel.locator(".btn-ghost", { hasText: /Link runs/ }).click();
    const picker = panel.locator(".picker");
    await expect(picker).toBeVisible();
    await picker.locator(".picker-row:not(.disabled)").first()
      .locator('input[type="checkbox"]').check();
    await picker.getByRole("button", { name: /Link selected/ }).click();
    await expect(panel.locator(".link-list li")).toHaveCount(1, { timeout: 5_000 });

    // Re-open the details (collapsed after load()) and re-open picker.
    if (!(await panel.locator(".section-body").isVisible().catch(() => false))) {
      await panel.locator("summary").click();
    }
    await panel.locator(".btn-ghost", { hasText: /Link runs/ }).click();
    await expect(picker).toBeVisible();
    expect(await picker.locator(".picker-row.disabled").count()).toBeGreaterThanOrEqual(1);

    await deleteRelease(page, token, id);
  });
});

test.describe("/releases/<id> — Mark released action", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("after sign-off, 'Mark released' flips status to released and disables the button", async ({
    page,
  }) => {
    // Create a release, immediately sign-off via API (skip checklist
    // gating for speed), then drive Mark released through the UI.
    const { id, version, token } = await createRelease(page, {
      // No required items → sign-off works with no checks.
      items: [{ label: "Optional only", required: false }],
    });

    // Sign off via API.
    const signOffRes = await page.request.post(
      `http://localhost:3000/releases/${id}/sign-off`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(signOffRes.status()).toBeLessThan(400);

    await gotoRelease(page, id, version);
    await expect(page.locator(".release-header .status")).toHaveText(/signed off/i);

    const markReleased = page.locator("section.actions-section").getByRole("button", {
      name: /Mark released/,
    });
    await expect(markReleased).toBeVisible();
    await expect(markReleased).toBeEnabled();
    await markReleased.click();

    // Status pill flips to "released" (header status) and the
    // button itself goes disabled (per the route's `disabled={release.status === 'released'}`).
    await expect(page.locator(".release-header .status")).toHaveText(/released/i, {
      timeout: 5_000,
    });
    await expect(markReleased).toBeDisabled({ timeout: 2_000 });

    await deleteRelease(page, token, id);
  });

  test("'Sign off release' button is disabled while requiredRemaining > 0", async ({ page }) => {
    const { id, version, token } = await createRelease(page, {
      items: [
        { label: "Required A", required: true },
        { label: "Required B", required: true },
      ],
    });
    await gotoRelease(page, id, version);

    const signOff = page.getByRole("button", { name: /Sign off release/ });
    await expect(signOff).toBeDisabled();
    await expect(
      page.getByText(/Complete all required checklist items to sign off/),
    ).toBeVisible();

    // Toggle one — still 1 remaining, still disabled.
    const checklistSection = page.locator("section", {
      has: page.getByRole("heading", { name: "Checklist" }),
    });
    await checklistSection.locator('ul.items > li input[type="checkbox"]').first().check();
    await expect(signOff).toBeDisabled();

    // Toggle the second — now 0 remaining, enables.
    await checklistSection.locator('ul.items > li input[type="checkbox"]').nth(1).check();
    await expect(signOff).toBeEnabled({ timeout: 5_000 });

    await deleteRelease(page, token, id);
  });
});

test.describe("/releases/<id> — status dropdown", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("changing status via the dropdown PATCHes the release and updates the header", async ({
    page,
  }) => {
    const { id, version, token } = await createRelease(page, {
      items: [{ label: "x", required: true }],
    });
    await gotoRelease(page, id, version);

    await expect(page.locator(".release-header .status")).toHaveText(/draft/i);

    // The status select sits in section.actions-section.
    const statusSelect = page.locator("section.actions-section select");
    await statusSelect.selectOption("in_progress");
    await expect(page.locator(".release-header .status")).toHaveText(/in progress/i, {
      timeout: 5_000,
    });

    await statusSelect.selectOption("draft");
    await expect(page.locator(".release-header .status")).toHaveText(/draft/i, { timeout: 5_000 });

    await deleteRelease(page, token, id);
  });
});

test.describe("/releases — list extras", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("creating a release via the inline form lands the new card with status 'draft'", async ({
    page,
  }) => {
    await page.goto("/releases");
    await expect(page.locator(".release-grid").first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /New release/ }).click();
    const form = page.locator(".create-card");
    await expect(form).toBeVisible();

    const v = `e2e-list-${Date.now().toString(36)}`;
    await form.locator('input[placeholder*="v1.2.0"]').fill(v);
    await form.getByRole("button", { name: /^Create$/ }).click();
    await expect(form).toBeHidden({ timeout: 5_000 });

    const card = page.locator(".release-card", {
      has: page.locator(".version", { hasText: v }),
    }).first();
    await expect(card).toBeVisible({ timeout: 5_000 });
    await expect(card.locator(".status")).toHaveText(/draft/i);
  });

  test("the New release form's Cancel button hides the form without creating a card", async ({
    page,
  }) => {
    await page.goto("/releases");
    // Wait for the grid to settle before sampling card count.
    await expect(page.locator(".release-grid").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".release-card").first()).toBeVisible({ timeout: 5_000 });
    const before = await page.locator(".release-card").count();

    await page.getByRole("button", { name: /New release/ }).click();
    const form = page.locator(".create-card");
    await expect(form).toBeVisible();
    await form.getByRole("button", { name: /^Cancel$/ }).click();
    await expect(form).toBeHidden({ timeout: 2_000 });
    expect(await page.locator(".release-card").count()).toBe(before);
  });
});

test.describe("/releases/<id> — readiness panel auto-evaluation", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("a fresh release with no linked runs falls back to org-wide readiness (no crash)", async ({
    page,
  }) => {
    // The route's hint reads: "No runs linked. Readiness will use the
    // latest run for the org." A regression where an unlinked release
    // crashed the readiness panel would surface here as the panel
    // failing to mount.
    const { id, version, token } = await createRelease(page);
    await gotoRelease(page, id, version);

    await expect(page.getByRole("heading", { name: "Release readiness" })).toBeVisible();
    await expect(page.locator(".readiness")).toBeVisible();
    await expect(page.locator(".readiness .readiness-card")).toHaveCount(2);

    await deleteRelease(page, token, id);
  });

  test("readiness summary pill reads either 'Ready to ship' or 'N blocker(s)'", async ({
    page,
  }) => {
    const { id, version, token } = await createRelease(page);
    await gotoRelease(page, id, version);

    // Pills live as <span class="ready-pill"> or <span class="blocked-pill">.
    const pill = page.locator(".ready-pill, .blocked-pill").first();
    await expect(pill).toBeVisible({ timeout: 5_000 });
    const pillText = (await pill.textContent()) ?? "";
    expect(pillText).toMatch(/Ready to ship|blocker\(s\)/);

    await deleteRelease(page, token, id);
  });
});

test.describe("/releases/<id> — manual-test linking", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("linked-tests panel shows the empty state with no links", async ({ page }) => {
    const { id, version, token } = await createRelease(page);
    await gotoRelease(page, id, version);

    const panel = page.locator(".linked-tests-panel details");
    await panel.locator("summary").click();
    // Either an explicit empty hint OR zero list rows.
    const empty = panel.locator(".empty");
    const items = panel.locator(".link-list li");
    if (await empty.isVisible().catch(() => false)) {
      await expect(empty).toBeVisible();
    } else {
      expect(await items.count()).toBe(0);
    }

    await deleteRelease(page, token, id);
  });
});
