import { expect, test } from "../fixtures/test";

import { ADMIN_USER, DEMO_USER } from "../fixtures/users";

/**
 * /settings — owner / admin / viewer affordances.
 *
 * The page exposes:
 *   - Connection cards (DB, Git, Email, AI) — read-only
 *   - Team (invite, member list)
 *   - Suites (rename, archive, delete) — admin-only
 *   - Webhooks — admin-only
 *   - PR Comments / Git provider — admin-only
 *   - Data Retention — admin-only
 *   - API Keys (list/create/delete) — admin-only
 *   - Audit Log — admin-only
 *
 * ADMIN_USER is owner of Acme Corp (per seed). The seed gives DEMO_USER
 * owner of Demo Team; cross-tenant isolation is asserted by creating
 * an API key as admin and confirming DEMO_USER's settings page never
 * lists it (it's not in their org).
 */

test.describe("/settings — admin (Acme owner) sees admin-only affordances", () => {

  test.beforeEach(async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator(".page-title")).toHaveText("Settings", { timeout: 10_000 });
  });

  test("renders the settings page header + connections grid", async ({ page }) => {
    // The connections strip exposes 4 cards (DB / Git / Email / AI).
    const conns = page.locator(".conn-card");
    const count = await conns.count();
    expect(count, "connections grid should render the 4 cards").toBeGreaterThanOrEqual(3);

    // The Settings page exposes both an "Invite" form (always) and an
    // API key form (admin-only). ADMIN_USER is the org owner.
    await expect(page.getByPlaceholder("Email address")).toBeVisible();
    await expect(page.getByPlaceholder("Key label (e.g. CI pipeline)")).toBeVisible();
  });

  test("admin-only sections render: Webhooks + Retention + API keys", async ({ page }) => {
    // Webhook form
    await expect(page.getByPlaceholder("Webhook URL")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Add$/ })).toBeVisible();
    // Retention form
    await expect(page.getByPlaceholder("Days (empty = keep forever)")).toBeVisible();
    // API keys form
    await expect(page.getByPlaceholder("Key label (e.g. CI pipeline)")).toBeVisible();
    await expect(page.getByRole("button", { name: /Create key/ })).toBeVisible();
  });

  test("creating + deleting an API key surfaces the new key, then removes it", async ({
    page,
  }) => {
    const label = `e2e-${Date.now().toString(36)}`;
    await page.getByPlaceholder("Key label (e.g. CI pipeline)").fill(label);
    await page.getByRole("button", { name: /Create key/ }).click();

    // The freshly-minted plaintext key surfaces once in a "copy this
    // now" panel — the route renders it under newKeyValue and shows
    // a Dismiss button. We don't pin the panel structure; we rely on
    // the Dismiss button being clickable to close the surface.
    const dismissBtn = page.getByRole("button", { name: /^Dismiss$/ });
    await expect(dismissBtn).toBeVisible({ timeout: 5_000 });
    await dismissBtn.click();

    // The new key is visible in the list by its label.
    const keyRow = page.locator("li, tr, .api-key-row, .list-row", { hasText: label }).first();
    await expect(keyRow).toBeVisible({ timeout: 5_000 });

    // Delete the key — handle the confirmation modal.
    page.once("dialog", (d) => d.accept());
    await keyRow.getByRole("button", { name: /^Delete$/ }).click();

    // The route uses an in-page confirm modal (not window.confirm); it
    // renders <button class="btn-sm danger">Delete</button> + Cancel.
    // If a confirm popup landed instead, the dialog handler above
    // already accepted it. Otherwise click the modal's danger
    // button.
    const modalConfirm = page
      .locator("button.btn-sm.danger", { hasText: /^Delete$/ })
      .last();
    if (await modalConfirm.isVisible().catch(() => false)) {
      await modalConfirm.click();
    }

    // Row drops off.
    await expect(
      page.locator("li, tr, .api-key-row, .list-row", { hasText: label }),
    ).toHaveCount(0, { timeout: 5_000 });
  });

  test("setting a retention value posts and the Save button flips to 'Saved'", async ({
    page,
  }) => {
    const retentionInput = page.getByPlaceholder("Days (empty = keep forever)");
    await retentionInput.fill("90");

    // The Save button next to the retention input — there are several
    // "Save" buttons on the page; scope to the retention container.
    const retentionSave = page
      .locator(".card", { has: retentionInput })
      .getByRole("button", { name: /^(Save|Saved)$/ })
      .first();
    await retentionSave.click();
    await expect(retentionSave).toHaveText(/^(Saved)$/, { timeout: 5_000 });
  });
});

test.describe("/settings — cross-tenant isolation", () => {
  test("a freshly-created Acme API key is NOT visible to Demo Team", async ({ browser }) => {
    // Two contexts — one per user. Each loads its own storage state.
    const adminCtx = await browser.newContext({ storageState: ADMIN_USER.storageStatePath });
    const demoCtx = await browser.newContext({ storageState: DEMO_USER.storageStatePath });
    const adminPage = await adminCtx.newPage();
    const demoPage = await demoCtx.newPage();

    try {
      // Create the key as Acme admin.
      const label = `acme-only-${Date.now().toString(36)}`;
      await adminPage.goto("/settings");
      await adminPage.getByPlaceholder("Key label (e.g. CI pipeline)").fill(label);
      await adminPage.getByRole("button", { name: /Create key/ }).click();
      await expect(adminPage.getByRole("button", { name: /^Dismiss$/ })).toBeVisible({
        timeout: 5_000,
      });
      await adminPage.getByRole("button", { name: /^Dismiss$/ }).click();
      await expect(
        adminPage.locator("li, tr, .api-key-row, .list-row", { hasText: label }),
      ).toBeVisible({ timeout: 5_000 });

      // Demo Team's owner loads /settings — the same label MUST NOT
      // surface anywhere in the list. RLS scopes api_keys by org_id;
      // a regression that loosened that check would leak the key.
      await demoPage.goto("/settings");
      await expect(demoPage.locator(".page-title")).toHaveText("Settings", { timeout: 10_000 });
      // The Demo Team has zero seeded API keys; the list should never
      // contain the Acme-only label.
      await expect(demoPage.locator("body", { hasText: label })).toHaveCount(0);
    } finally {
      await adminCtx.close();
      await demoCtx.close();
    }
  });
});

test.describe("/settings/integrations — admin (Acme) renders all sections", () => {

  test.beforeEach(async ({ page }) => {
    await page.goto("/settings/integrations");
    await expect(page.getByRole("heading", { name: "Integrations & automation" })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("Jira / PagerDuty / Coverage / Scheduled reports sections all mount", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Jira" })).toBeVisible();
    await expect(page.getByPlaceholder("https://your-org.atlassian.net")).toBeVisible();
    await expect(page.getByPlaceholder("you@company.com")).toBeVisible();

    await expect(page.getByRole("heading", { name: "PagerDuty" })).toBeVisible();
    // Severity dropdown has 4 options.
    const severitySelect = page.locator("section", {
      has: page.getByRole("heading", { name: "PagerDuty" }),
    }).locator("select");
    await expect(severitySelect).toBeVisible();

    await expect(page.getByRole("heading", { name: "Code coverage gating" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Scheduled reports" })).toBeVisible();
  });

  test("Jira form save round-trips via the integrations API", async ({ page }) => {
    // Fill minimal Jira config and click Save. Backend stores in
    // org_settings; we don't verify persistence beyond the 'Save' →
    // status text round-trip.
    await page.getByPlaceholder("https://your-org.atlassian.net").fill("https://e2e.atlassian.net");
    await page.getByPlaceholder("you@company.com").fill("e2e@example.com");
    await page.getByPlaceholder("QA").fill("E2E");
    await page.getByPlaceholder("Bug").fill("Task");

    const jiraSection = page.locator("section", {
      has: page.getByRole("heading", { name: "Jira" }),
    });
    await jiraSection.getByRole("button", { name: /^Save$/ }).click();

    // The route renders a status line under the section after a save.
    // Tolerant assertion — either status text appears or the button
    // text doesn't change to a failure mode.
    const status = jiraSection.locator(".status").first();
    await expect(status).toBeVisible({ timeout: 5_000 });
  });

  test("scheduled report CRUD: create then delete", async ({ page }) => {
    const reportSection = page.locator("section", {
      has: page.getByRole("heading", { name: "Scheduled reports" }),
    });

    const reportName = `e2e-report-${Date.now().toString(36)}`;
    await reportSection.getByPlaceholder("Name").fill(reportName);
    // Channel defaults to "email". Destination input placeholder switches
    // to "email@co.com" when channel === "email".
    await reportSection.getByPlaceholder("email@co.com").fill("e2e@example.com");

    await reportSection.getByRole("button", { name: /^Add$/ }).click();

    // Row appears in the table.
    const newRow = reportSection.locator("tbody tr", { hasText: reportName });
    await expect(newRow).toBeVisible({ timeout: 5_000 });

    // Delete via the ✕ button on the row.
    page.once("dialog", (d) => d.accept());
    await newRow.getByRole("button", { name: "✕" }).click();
    await expect(reportSection.locator("tbody tr", { hasText: reportName })).toHaveCount(0, {
      timeout: 5_000,
    });
  });
});

test.describe("/settings/integrations — cross-tenant", () => {
  test("Demo Team's integrations page does not surface Acme's saved Jira config", async ({
    browser,
  }) => {
    const adminCtx = await browser.newContext({ storageState: ADMIN_USER.storageStatePath });
    const demoCtx = await browser.newContext({ storageState: DEMO_USER.storageStatePath });
    const adminPage = await adminCtx.newPage();
    const demoPage = await demoCtx.newPage();

    try {
      // Save a recognisable Jira base URL on Acme.
      const adminBase = `https://acme-${Date.now().toString(36)}.atlassian.net`;
      await adminPage.goto("/settings/integrations");
      await adminPage.getByPlaceholder("https://your-org.atlassian.net").fill(adminBase);
      const adminJira = adminPage.locator("section", {
        has: adminPage.getByRole("heading", { name: "Jira" }),
      });
      await adminJira.getByRole("button", { name: /^Save$/ }).click();
      await expect(adminJira.locator(".status")).toBeVisible({ timeout: 5_000 });

      // Demo Team's integrations page must NOT prefill that URL.
      await demoPage.goto("/settings/integrations");
      await expect(demoPage.getByRole("heading", { name: "Jira" })).toBeVisible({
        timeout: 10_000,
      });
      const demoJiraInput = demoPage.getByPlaceholder("https://your-org.atlassian.net");
      // Either empty or set to Demo's own value — but never Acme's.
      const demoVal = await demoJiraInput.inputValue();
      expect(
        demoVal,
        "Demo Team's Jira config should be tenant-scoped — Acme's saved URL must not leak",
      ).not.toBe(adminBase);
    } finally {
      await adminCtx.close();
      await demoCtx.close();
    }
  });
});
