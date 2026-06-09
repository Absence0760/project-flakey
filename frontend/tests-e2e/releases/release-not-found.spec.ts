import { expect, test } from "../fixtures/test";
import { gotoReleaseReady } from "./release-helpers";

/**
 * /releases/<id> — a non-existent (or cross-tenant) release id renders the
 * error state, not a crash or an infinite spinner.
 *
 * INVARIANT PROTECTED
 * ===================
 * GET /releases/:id 404s for an id that doesn't exist in the caller's tenant
 * (RLS makes another org's release indistinguishable from a missing one). The
 * route's load() catches that and sets `error`; the page must surface it and
 * still flip `data-ready` (the README contract: data-ready goes true once the
 * fetch SETTLES, resolved OR errored). A regression that left the page on the
 * "Loading…" branch forever — or threw — would strand the user.
 *
 * DETERMINISM: a deliberately out-of-range id (no setup needed). Gate on
 * data-ready, which is the documented "settled" signal even on error.
 */
test.describe("/releases/<id> — not-found handling", () => {
  test("a bogus release id shows the error state and still reports data-ready", async ({ page }) => {
    // Well beyond any seeded/created id, within int4 range.
    const BOGUS_ID = 2_000_000_000;

    await gotoReleaseReady(page, BOGUS_ID);

    // The error branch renders the load() failure message…
    await expect(page.locator(".page p.error")).toHaveText("Failed to load release");
    // …and none of the loaded-release chrome is present.
    await expect(page.locator("section.readiness")).toHaveCount(0);
    await expect(page.locator("header.release-header")).toHaveCount(0);
    // The "back to all releases" link still works as an escape hatch.
    await expect(page.getByRole("link", { name: /All releases/ })).toBeVisible();
  });
});
