import { expect, test, type Locator, type Page } from "../fixtures/test";

import { VIEWER_USER } from "../fixtures/users";

/**
 * /settings/integrations — Scheduled Reports CRUD + "Run now".
 *
 * The sibling integrations.spec.ts covers webhooks / Jira / PagerDuty but
 * NOT the Scheduled Reports surface. This spec exercises the report block of
 * `src/routes/(app)/settings/integrations/+page.svelte` (backed by
 * `backend/src/routes/reports.ts`) through the actual UI: the create form,
 * the report table, "Run now", and the delete button.
 *
 * Determinism notes:
 *   - All assertions are scoped to a UNIQUELY-named report (`e2e-report-…`)
 *     so this is parallel-safe against the seed's one report, the other
 *     worker tenants, and concurrent runs of this same spec — never against
 *     a total row count.
 *   - "Run now" uses `channel: "email"`. `sendReportNow` → `deliverReport`
 *     → `deliverEmailReport` swallows its own SMTP errors, so the send always
 *     succeeds deterministically against the local Mailpit sink (the dev
 *     default `SMTP_PORT=1025`) — no external destination is contacted. The
 *     real, deterministic UI signal of a successful run is the row's
 *     "Last sent" cell flipping from "never" to a rendered timestamp (the
 *     route reloads the list after the POST resolves), so we wait on that.
 *   - Readiness: the create form is gated on the route's `onMount` fetch
 *     having settled. We wait on the "Add" button being attached + the
 *     "Scheduled reports" section heading rather than sleeping; the table is
 *     conditionally rendered (`{#if reports.length > 0}`), so we wait on our
 *     own row appearing/disappearing as the real signal.
 *
 * Default storageState is the per-worker admin tenant (fixtures/test.ts), so
 * the create/run/delete path runs as an admin — the report routes are
 * admin-only. The viewer-403 contract is pinned with VIEWER_USER below.
 */

/** The unique <tr> for a report by name, scoped to the reports table. */
function reportRow(page: Page, name: string): Locator {
  return page.locator("table tbody tr", { hasText: name });
}

test.describe("settings/integrations — scheduled reports CRUD + run", () => {

  test("admin creates an email report via the form, runs it now, then deletes it", async ({
    page,
  }) => {
    test.setTimeout(30_000);

    // Unique per (worker, time) so concurrent workers + the seed's report
    // never collide on name.
    const name = `e2e-report-${test.info().parallelIndex}-${Date.now().toString(36)}`;

    await page.goto("/settings/integrations");

    // Gate on the route's reports fetch having settled: the create form's
    // "Add" button lives in the Scheduled reports section, which renders
    // unconditionally once the page mounts.
    await expect(
      page.getByRole("heading", { name: "Scheduled reports" }),
    ).toBeVisible({ timeout: 10_000 });
    const addBtn = page
      .locator(".create-report")
      .getByRole("button", { name: "Add" });
    await expect(addBtn).toBeVisible();

    // --- Create (daily / email, the form defaults) ---
    await page.locator(".create-report").getByPlaceholder("Name").fill(name);
    // Channel defaults to "email"; the destination placeholder is the email
    // hint in that case. Fill a valid recipient.
    await page
      .locator(".create-report")
      .getByPlaceholder("email@co.com")
      .fill(`${name}@example.test`);
    await addBtn.click();

    // The new row appears in the list — real signal, scoped to our name.
    const row = reportRow(page, name);
    await expect(row).toBeVisible({ timeout: 10_000 });

    // The row reflects what we created: daily cadence, email channel, and our
    // destination. Pin the cells we control rather than the whole row text.
    await expect(row).toContainText("daily");
    await expect(row).toContainText("email");
    await expect(row).toContainText(`${name}@example.test`);
    // Freshly created → never sent.
    await expect(row.getByText("never")).toBeVisible();

    // --- Run now ---
    // The "Run now" button POSTs /reports/:id/run then reloads the list. The
    // deterministic success signal in the UI is the "Last sent" cell ceasing
    // to read "never" — i.e. last_sent_at got stamped. We assert the POST
    // succeeds (200) AND the UI reflects it, rather than just clicking.
    const runResponse = page.waitForResponse(
      (r) => /\/reports\/\d+\/run$/.test(r.url()) && r.request().method() === "POST",
    );
    await row.getByRole("button", { name: "Run now" }).click();
    const ran = await runResponse;
    expect(ran.status(), "run-now POST must succeed for an email report").toBe(200);
    expect(await ran.json()).toMatchObject({ triggered: true });

    // The row's "Last sent" cell no longer reads "never" once the list
    // reloads with the stamped last_sent_at.
    await expect(
      row.getByText("never"),
      "after a successful run, Last sent should no longer be 'never'",
    ).toHaveCount(0, { timeout: 10_000 });

    // --- Delete (clean up after ourselves) ---
    // deleteReport() uses window.confirm — accept it.
    page.once("dialog", (d) => d.accept());
    await row.getByRole("button", { name: "✕" }).click();

    // The row drops off the list — real signal, scoped to our name.
    await expect(reportRow(page, name)).toHaveCount(0, { timeout: 10_000 });
  });

  test("a viewer-role user cannot create a scheduled report (admin-only, 403)", async ({
    browser,
  }) => {
    test.setTimeout(15_000);
    // VIEWER_USER is a genuine viewer-role member of acme; the reports
    // mutating routes require admin. Pin the contract the same way the
    // integrations spec pins the webhooks/Jira/PagerDuty viewer-403s.
    const viewerCtx = await browser.newContext({
      storageState: VIEWER_USER.storageStatePath,
    });
    try {
      const viewerPage = await viewerCtx.newPage();
      await viewerPage.goto("/dashboard");
      const token = await viewerPage.evaluate(
        () => localStorage.getItem("bt_token") ?? "",
      );

      const res = await viewerPage.request.post("http://localhost:3000/reports", {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        data: {
          name: `viewer-denied-${Date.now().toString(36)}`,
          cadence: "daily",
          channel: "email",
          destination: "viewer@example.test",
        },
      });
      expect(res.status()).toBe(403);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: expect.stringMatching(/admin/i),
      });
    } finally {
      await viewerCtx.close();
    }
  });
});
