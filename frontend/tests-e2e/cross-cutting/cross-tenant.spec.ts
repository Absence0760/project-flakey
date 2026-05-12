import { expect, test } from "@playwright/test";

import { ADMIN_USER, DEMO_USER } from "../fixtures/users";

/**
 * Multi-tenant isolation — the security backbone of project-flakey.
 *
 * The backend connects as the non-superuser `flakey_app` so Postgres
 * RLS engages on every query routed through tenantQuery /
 * tenantTransaction. Org-scoping is set per-statement via
 * `set_config('app.current_org_id', ...)` inside a transaction.
 *
 * In the seed:
 *   - admin@example.com is the owner of "Acme Corp" (org 1) and
 *     receives 50+ seeded runs.
 *   - demo@example.com is the owner of "Demo Team" (org 2) and
 *     receives zero runs.
 *
 * If RLS or tenantQuery breaks (e.g. a route slips into raw
 * pool.query, an `org_id = $1` filter gets dropped, a policy is
 * scoped too widely), demo would either see Acme's runs in their
 * list, or be able to fetch /runs/<acme-run-id> directly.
 *
 * These two scenarios are the tests below.
 */

test.describe("multi-tenant isolation", () => {
  test.describe("admin (Acme Corp) — primary tenant with seed data", () => {
    test.use({ storageState: ADMIN_USER.storageStatePath });

    test("runs list shows Acme runs (seed creates 50+)", async ({ page }) => {
      await page.goto("/");
      // Wait for the loading state to clear.
      await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 10_000 });

      const rowCount = await page.locator("tr.run-row").count();
      expect(rowCount, "admin should see at least one Acme run").toBeGreaterThan(0);

      // Sidebar org chrome confirms we're in Acme.
      await expect(page.locator("aside.sidebar .org-name")).toHaveText("Acme Corp");
    });
  });

  test.describe("demo (Demo Team) — empty tenant", () => {
    test.use({ storageState: DEMO_USER.storageStatePath });

    test("runs list shows the empty state — Demo Team has no runs", async ({ page }) => {
      await page.goto("/");

      // Empty-state copy from src/routes/(app)/+page.svelte:395-401.
      // We assert on the visible structural element (.empty wrapper)
      // rather than the exact copy because the message branches based
      // on whether filters are active. With default filters this is
      // the "no runs uploaded yet" message.
      await expect(page.locator(".empty")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator("tr.run-row")).toHaveCount(0);

      // Sidebar org chrome confirms we're in Demo Team — proves the
      // assertion isn't just "demo logged into the wrong org".
      await expect(page.locator("aside.sidebar .org-name")).toHaveText("Demo Team");
    });

    test("direct GET to an Acme-owned run id fails closed (no leak via /runs/<id>)", async ({
      page,
    }) => {
      // Run id 1 is the first row created by the seed for Acme. If
      // the seed rotates ids (it doesn't currently — the seed is run
      // against a fresh DB), this would need to come from a more
      // robust source like an admin-side fetch + cross-tab.
      await page.goto("/runs/1");

      // The fetchRun() promise rejects on a 404; the page renders the
      // error branch. Either:
      //   - the loading shell stays mounted with an error message, OR
      //   - the page shows nothing of value (no h1 "Run #1", no specs)
      // The Critical regression we're catching: demo seeing "Run #1"
      // with Acme's actual specs and stats. So the inverse assertion
      // is the right contract.
      const heading = page.getByRole("heading", { name: /^Run #1\s/ });
      await expect(heading).toHaveCount(0, { timeout: 10_000 });

      // The error pane should appear. Source: src/routes/(app)/runs/[id]/+page.svelte:464.
      await expect(page.locator(".status-msg.error")).toBeVisible({ timeout: 10_000 });
    });

    test("manual-tests page shows the empty state — Demo Team has no manual tests", async ({
      page,
    }) => {
      await page.goto("/manual-tests");
      // The route renders <p class="empty"> when tests.length === 0,
      // before the table even mounts.
      await expect(page.locator(".empty")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator("table.tests")).toHaveCount(0);
    });

    test("releases page shows the empty state — Demo Team has no releases", async ({
      page,
    }) => {
      await page.goto("/releases");
      await expect(page.locator(".empty")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(".release-card")).toHaveCount(0);
    });

    test("direct GET to an Acme-owned release id fails closed (no leak via /releases/<id>)", async ({
      page,
    }) => {
      // The first seeded Acme release is v2.4.0. We don't know its
      // id from the demo context, but we can probe a low id (1) to
      // mirror the run-id leak test.
      await page.goto("/releases/1");

      // The Acme version header must NOT render — that would mean a
      // leak across tenants. Either the page stays on a loader/error
      // branch, or it bounces. Critical regression contract.
      await expect(page.getByRole("heading", { name: "v2.4.0" })).toHaveCount(0, {
        timeout: 10_000,
      });
      await expect(page.getByRole("heading", { name: "v2.5.0" })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "v2.3.0" })).toHaveCount(0);
    });
  });
});
