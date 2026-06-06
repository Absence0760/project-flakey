import { expect, test, type Page } from "../fixtures/test";


/**
 * Roadmap Phase 12 / commit e133342 — the dashboard's runs list now
 * reacts to `/live/start` and `/live/:id/abort` via an org-scoped SSE
 * subscription (`/live/stream`) instead of polling `/live/active`
 * every 5 s.
 *
 * The pre-SSE `live-list-visibility.spec.ts` allowed up to 25 s for a
 * new LIVE card to appear (covering the worst-case 5 s poll cycle +
 * fetch latency). These specs assert the SSE-delivery flow is
 * substantially faster — anything over ~3 s indicates polling crept
 * back in or the EventSource isn't connecting. They also exercise
 * the new pieces specifically:
 *
 *   1. EventSource handshake to /live/stream (sub-second visibility)
 *   2. Initial snapshot — a run started BEFORE page load surfaces
 *      on first paint via the snapshot event, not a poll
 *   3. /live/active is no longer used by the dashboard (no polling
 *      requests after the initial load)
 */

async function getToken(page: Page): Promise<string> {
  // Keys remain `bt_*` per frontend/CLAUDE.md (legacy prefix kept to
  // avoid invalidating sessions on the rebrand).
  return page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

// Deterministic gate for "the /live/stream EventSource is open". The runs
// page flips data-sse-connected="true" the moment the EventSource delivers
// its first message — the backend always sends a `snapshot` on connect — so
// this replaces the old "wait for a row, then sleep and hope the handshake
// finished" pattern with a real readiness signal. Waiting on it also implies
// the page has hydrated and connectLiveStream() has run.
async function waitForLiveStream(page: Page): Promise<void> {
  await expect(
    page.locator('.page[data-sse-connected="true"]'),
    "runs page must signal an open /live/stream EventSource via data-sse-connected",
  ).toBeVisible({ timeout: 15_000 });
}

async function startLive(page: Page, token: string, suite: string): Promise<number> {
  const res = await page.request.post("http://localhost:3000/live/start", {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: { suite, branch: "main", commitSha: "phase12-sse" },
  });
  expect(res.status(), "live/start should return 201").toBe(201);
  return (await res.json()).id as number;
}

async function abortRun(page: Page, token: string, runId: number, reason: string): Promise<void> {
  await page.request.post(`http://localhost:3000/live/${runId}/abort`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: { reason },
  }).catch(() => {});
}

async function deleteRun(page: Page, token: string, runId: number): Promise<void> {
  await page.request.delete(`http://localhost:3000/runs/${runId}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

test.describe("/live/stream — org-scoped SSE drives the dashboard runs list", () => {

  test("a fresh /live/start surfaces within ~2 s (SSE add delta — not 5 s polling)", async ({
    page,
  }) => {
    test.setTimeout(45_000);

    await page.goto("/runs");
    // Gate on the real SSE-handshake signal before firing /live/start so
    // the add-delta can't race a not-yet-open EventSource.
    await waitForLiveStream(page);

    const token = await getToken(page);
    const suite = `live-stream-add-${Date.now().toString(36)}`;
    const runId = await startLive(page, token, suite);

    const newRow = page.locator(`tr.run-row[data-run-id="${runId}"]`);
    // Tight bound: ~2 s. With polling this would frequently fail
    // (5 s cycle + DB fetch). With SSE the delta lands in ms; the
    // refetch + render is the only real cost.
    await expect(
      newRow,
      "live-started run must appear via SSE delta within 2 s",
    ).toBeVisible({ timeout: 2500 });

    await expect(newRow.locator(".live-badge")).toBeVisible({ timeout: 5000 });

    await abortRun(page, token, runId, "stream-add cleanup");
    await deleteRun(page, token, runId);
  });

  test("a /live/:id/abort drops the LIVE badge within ~2 s (SSE remove delta)", async ({
    page,
  }) => {
    test.setTimeout(45_000);

    await page.goto("/runs");
    await waitForLiveStream(page);

    const token = await getToken(page);
    const suite = `live-stream-remove-${Date.now().toString(36)}`;
    const runId = await startLive(page, token, suite);

    const row = page.locator(`tr.run-row[data-run-id="${runId}"]`);
    await expect(row).toBeVisible({ timeout: 2500 });
    await expect(row.locator(".live-badge")).toBeVisible({ timeout: 5000 });

    await abortRun(page, token, runId, "phase12 SSE remove delta");

    // Pre-SSE this allowed 20 s; SSE delta delivers within ms.
    await expect(
      row.locator(".live-badge"),
      "LIVE badge must drop via SSE remove delta within 2 s",
    ).toHaveCount(0, { timeout: 2500 });

    await deleteRun(page, token, runId);
  });

  test("a run started BEFORE page load shows up via the snapshot event on first paint", async ({
    page,
  }) => {
    // The snapshot event is the SSE-specific affordance — before
    // Phase 12 the dashboard had to wait for the first poll tick
    // (~5 s) to populate `liveRunIds`. With the snapshot it ships
    // before the EventSource has streamed a single delta, so the
    // LIVE badge appears as soon as the runs-list refetch completes.
    test.setTimeout(45_000);

    // Authenticate via a stand-alone page first so we can mint a
    // token without loading the dashboard yet.
    await page.goto("/runs");
    await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 15_000 });
    const token = await getToken(page);

    // Start the live run BEFORE navigating fresh to /.
    const suite = `live-stream-snapshot-${Date.now().toString(36)}`;
    const runId = await startLive(page, token, suite);

    try {
      // Hard reload so the dashboard mounts from scratch and
      // connectLiveStream() runs against an org with one in-flight run.
      await page.goto("/runs");
      await expect(page.locator("tr.run-row").first()).toBeVisible({ timeout: 15_000 });

      const row = page.locator(`tr.run-row[data-run-id="${runId}"]`);
      // The snapshot fires immediately on EventSource connect — should
      // be well under 3 s even on a cold load.
      await expect(
        row.locator(".live-badge"),
        "LIVE badge must come from the SSE snapshot, not a poll",
      ).toBeVisible({ timeout: 3000 });
    } finally {
      await abortRun(page, token, runId, "snapshot test cleanup");
      await deleteRun(page, token, runId);
    }
  });

  test("the dashboard does NOT poll /live/active (updates arrive via SSE, not polling)", async ({
    page,
  }) => {
    // Regression guard against a future refactor accidentally restoring
    // the poll loop. Rather than sleeping for a poll cycle and hoping a
    // tick would have fired, we drive a real start→appear→abort→remove
    // round-trip — both deltas must arrive over the EventSource — and
    // assert /live/active was never requested across the whole cycle. If
    // a poll loop crept back in, either the badge wouldn't appear via the
    // SSE delta or a /live/active request would be captured.
    test.setTimeout(45_000);

    const polledUrls: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/live/active")) polledUrls.push(url);
    });

    await page.goto("/runs");
    await waitForLiveStream(page);

    const token = await getToken(page);
    const suite = `live-stream-nopoll-${Date.now().toString(36)}`;
    const runId = await startLive(page, token, suite);
    const row = page.locator(`tr.run-row[data-run-id="${runId}"]`);

    // Appears via the SSE add-delta...
    await expect(row.locator(".live-badge")).toBeVisible({ timeout: 2500 });
    // ...and clears via the SSE remove-delta.
    await abortRun(page, token, runId, "no-poll cleanup");
    await expect(row.locator(".live-badge")).toHaveCount(0, { timeout: 2500 });
    await deleteRun(page, token, runId);

    assert(
      polledUrls.length === 0,
      `dashboard must not poll /live/active — saw ${polledUrls.length} request(s): ${polledUrls.join(", ")}`,
    );
  });

  test("the dashboard opens an EventSource to /live/stream on mount", async ({ page }) => {
    // Direct positive assertion: the new code path is in use.
    test.setTimeout(30_000);

    const streamRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/live/stream")) streamRequests.push(url);
    });

    await page.goto("/runs");
    // data-sse-connected only flips once the EventSource has delivered a
    // message, which guarantees the /live/stream request was made and
    // captured by the listener above.
    await waitForLiveStream(page);

    assert(
      streamRequests.length >= 1,
      `dashboard must open at least one /live/stream EventSource — saw ${streamRequests.length}`,
    );
    // The request must carry the ?token= auth fallback (EventSource
    // can't set Authorization headers).
    assert(
      streamRequests[0].includes("token="),
      `/live/stream URL must carry ?token=… — got ${streamRequests[0]}`,
    );
  });
});

// Pure-runtime assert helper — Playwright's assert isn't auto-imported
// and `expect()` would tie us to its rich matcher overhead for what's
// really just a boolean check. Kept inline because it's only used by
// the two regression-guard specs above.
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
