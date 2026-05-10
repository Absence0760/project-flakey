import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "./fixtures/users";

/**
 * Issue #41 — a live run started via POST /live/start must appear in
 * the dashboard's runs list (`/`) WITHOUT a page reload, while the
 * run is still in progress (before any events are posted).
 *
 * The page polls /live/active every 5 s. The new run id arrives in
 * that response, the list refetches, and the new card renders with
 * the LIVE badge.
 *
 * Before the fix in routes/(app)/+page.svelte's pollLiveRuns, the
 * polling loop only refetched the list when a run DISAPPEARED from
 * the active set (i.e. a run finishing). Additions silently updated
 * the badge map but never refetched, so a brand-new live run was
 * invisible until the user reloaded.
 */

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

async function startLive(page: Page, token: string, suite: string): Promise<number> {
  const res = await page.request.post("http://localhost:3000/live/start", {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: { suite, branch: "main", commitSha: "issue-41" },
  });
  expect(res.status(), "live/start should return 201").toBe(201);
  return (await res.json()).id as number;
}

async function deleteRun(page: Page, token: string, runId: number): Promise<void> {
  await page.request.delete(`http://localhost:3000/runs/${runId}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

test.describe("issue #41 — live runs surface in the runs list mid-flight", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("a fresh /live/start run appears as a card with the LIVE badge without reloading", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await page.goto("/");
    // Wait for at least one existing card so we know the page is
    // hydrated and pollLiveRuns has armed its 5-second interval.
    await expect(page.locator("a.run-card").first()).toBeVisible({ timeout: 15_000 });

    const token = await getToken(page);
    const suite = `live-list-visibility-${Date.now().toString(36)}`;
    const runId = await startLive(page, token, suite);

    // The poll runs every 5 s; the new run only appears after a
    // poll cycle detects the new id in /live/active and refetches
    // the list. Give it up to 25 s — generous enough that a slow
    // cold poll won't flake, tight enough that a true regression
    // (no refetch on additions, the original bug) still fails.
    const newCard = page.locator(`a.run-card[href="/runs/${runId}"]`);
    await expect(
      newCard,
      "live-started run must appear in the dashboard list without a reload",
    ).toBeVisible({ timeout: 25_000 });

    await expect(
      newCard.locator(".live-badge"),
      "the new card must show the LIVE badge",
    ).toBeVisible({ timeout: 10_000 });

    await deleteRun(page, token, runId);
  });

  test("two parallel /live/start runs both surface as cards with LIVE badges (cardinality / no dedup)", async ({
    page,
  }) => {
    // Real CI matrix runs spawn multiple live reporters concurrently
    // (shards, browser-matrix, etc). The refetch on additions must
    // pick up BOTH new ids, not stop after the first one. A naive
    // "refresh on first add" would render only run A and silently
    // hide run B until the next poll cycle.
    test.setTimeout(60_000);

    await page.goto("/");
    await expect(page.locator("a.run-card").first()).toBeVisible({ timeout: 15_000 });

    const token = await getToken(page);
    const suffix = Date.now().toString(36);
    const runIdA = await startLive(page, token, `live-parallel-A-${suffix}`);
    const runIdB = await startLive(page, token, `live-parallel-B-${suffix}`);

    const cardA = page.locator(`a.run-card[href="/runs/${runIdA}"]`);
    const cardB = page.locator(`a.run-card[href="/runs/${runIdB}"]`);
    await expect(cardA, "first parallel live run must appear").toBeVisible({ timeout: 25_000 });
    await expect(cardB, "second parallel live run must appear").toBeVisible({ timeout: 25_000 });
    await expect(cardA.locator(".live-badge")).toBeVisible({ timeout: 10_000 });
    await expect(cardB.locator(".live-badge")).toBeVisible({ timeout: 10_000 });

    await deleteRun(page, token, runIdA);
    await deleteRun(page, token, runIdB);
  });

  test("a live run aborted mid-flight drops its LIVE badge in the list (abort path, distinct from clean finish)", async ({
    page,
  }) => {
    // /live/<id>/abort is the reporter-side graceful-shutdown path
    // (SIGINT/SIGTERM handler) and the stale-detection fallback.
    // Server-side it removes the id from /live/active just like a
    // clean finish, but the resulting run row has `aborted=true` and
    // no terminal stats — confirming the dashboard handles it the
    // same way nails down the UX parity.
    test.setTimeout(60_000);

    await page.goto("/");
    await expect(page.locator("a.run-card").first()).toBeVisible({ timeout: 15_000 });

    const token = await getToken(page);
    const suite = `live-abort-list-${Date.now().toString(36)}`;
    const runId = await startLive(page, token, suite);

    const card = page.locator(`a.run-card[href="/runs/${runId}"]`);
    await expect(card).toBeVisible({ timeout: 25_000 });
    await expect(card.locator(".live-badge")).toBeVisible({ timeout: 10_000 });

    const abortRes = await page.request.post(
      `http://localhost:3000/live/${runId}/abort`,
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        data: { reason: "test-driven abort to exercise list-side UX" },
      },
    );
    expect(abortRes.status()).toBeLessThan(400);

    // Within one poll cycle (~5 s) the badge must drop. The row
    // itself stays — the dashboard doesn't hide aborted runs.
    await expect(card.locator(".live-badge")).toHaveCount(0, { timeout: 20_000 });
    await expect(card, "aborted run must still be visible in the list").toBeVisible();

    await deleteRun(page, token, runId);
  });

  test("a run that finishes between polls still updates the card (regression guard for the existing 'removal' branch)", async ({
    page,
  }) => {
    // The fix replaces the removal-only refresh with a symmetric
    // refresh-on-any-change. This regression guard pins the
    // pre-existing behaviour so a future refactor of pollLiveRuns
    // can't quietly drop the finish-side refresh.
    test.setTimeout(60_000);

    await page.goto("/");
    await expect(page.locator("a.run-card").first()).toBeVisible({ timeout: 15_000 });

    const token = await getToken(page);
    const suite = `live-finish-refresh-${Date.now().toString(36)}`;
    const runId = await startLive(page, token, suite);

    // Wait for the new card + LIVE badge to render.
    const card = page.locator(`a.run-card[href="/runs/${runId}"]`);
    await expect(card).toBeVisible({ timeout: 25_000 });
    await expect(card.locator(".live-badge")).toBeVisible({ timeout: 10_000 });

    // Finish the run. The next poll cycle should remove the id
    // from /live/active and refetch — the LIVE badge then drops
    // and the card's terminal pass/fail badge appears.
    const finishRes = await page.request.post(
      `http://localhost:3000/live/${runId}/events`,
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        data: { type: "run.finished", stats: { total: 0, passed: 0, failed: 0, skipped: 0 } },
      },
    );
    expect(finishRes.status()).toBe(200);

    // Once a run.finished is observed by the live bus, /live/active
    // drops the id and the next pollLiveRuns tick refetches /runs.
    // The badge can take up to one poll cycle (~5s) to disappear.
    await expect(card.locator(".live-badge")).toHaveCount(0, { timeout: 20_000 });

    await deleteRun(page, token, runId);
  });
});
