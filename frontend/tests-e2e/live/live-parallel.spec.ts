import { expect, test, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * Live parallel-run isolation.
 *
 * Two reporters can hit the backend concurrently from completely
 * separate machines (a Playwright suite running on CI while a Cypress
 * suite runs locally, or two CI shards of the same tool). The
 * contract:
 *
 *   - Each run owns its own spec rows even when the file_path matches
 *     another run's spec exactly.
 *   - Each run owns its own test rows. A test.passed for run A with
 *     the same title as a pending test in run B must NOT flip B's row.
 *   - The /live/<id>/history feed never leaks events across runs.
 *   - A screenshot uploaded against run A never attaches to a same-named
 *     test in run B.
 *
 * The backend keys every per-run write on `runs.id` (or `specs.run_id`),
 * so this is a contract assertion on top of an already-correct
 * implementation — these tests catch any regression that loosens the
 * scoping.
 */

const POLL_TIMEOUT = 10_000;

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

async function startLive(page: Page, token: string, suite: string): Promise<number> {
  const res = await page.request.post("http://localhost:3000/live/start", {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: { suite, branch: "main", commitSha: "parallel" },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id as number;
}

async function postEvent(
  page: Page,
  token: string,
  runId: number,
  event: Record<string, unknown>,
): Promise<void> {
  const res = await page.request.post(`http://localhost:3000/live/${runId}/events`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: event,
  });
  expect(res.status(), `event ${event.type} should accept`).toBe(200);
}

async function deleteRun(page: Page, token: string, runId: number): Promise<void> {
  await page.request.delete(`http://localhost:3000/runs/${runId}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

type TestRow = { title: string; status: string; screenshot_paths?: string[] };
type SpecRow = { file_path: string; tests: TestRow[] };

async function fetchRunDetail(
  page: Page,
  token: string,
  runId: number,
): Promise<{ specs: SpecRow[] }> {
  const r = await page.request.get(`http://localhost:3000/runs/${runId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(r.status()).toBe(200);
  return r.json();
}

test.describe("live parallel — multiple concurrent runs do not collide", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("two parallel runs (same shape, same spec path) — events route to the correct run, no leak across rows", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto("/dashboard");
    const token = await getToken(page);
    const runA = await startLive(page, token, `parA-${Date.now().toString(36)}`);
    const runB = await startLive(page, token, `parB-${Date.now().toString(36)}`);

    // Same spec path on purpose — proves spec rows are scoped to runId.
    const sharedSpec = "tests/parallel/login.spec.ts";

    // Interleave aggressively. Promise.all here means the two POSTs hit
    // the server concurrently; the post-response IIFEs that drain the
    // DB writes also overlap, which is the surface area we're testing.
    await Promise.all([
      postEvent(page, token, runA, { type: "spec.started", spec: sharedSpec }),
      postEvent(page, token, runB, { type: "spec.started", spec: sharedSpec }),
    ]);
    await Promise.all([
      postEvent(page, token, runA, { type: "test.started", spec: sharedSpec, test: "A-test-1" }),
      postEvent(page, token, runB, { type: "test.started", spec: sharedSpec, test: "B-test-1" }),
      postEvent(page, token, runA, { type: "test.started", spec: sharedSpec, test: "A-test-2" }),
      postEvent(page, token, runB, { type: "test.started", spec: sharedSpec, test: "B-test-2" }),
    ]);
    await Promise.all([
      postEvent(page, token, runA, { type: "test.passed", spec: sharedSpec, test: "A-test-1", duration_ms: 100 }),
      postEvent(page, token, runB, { type: "test.failed", spec: sharedSpec, test: "B-test-1", duration_ms: 50, error: "B-only failure" }),
      postEvent(page, token, runA, { type: "test.passed", spec: sharedSpec, test: "A-test-2", duration_ms: 200 }),
      postEvent(page, token, runB, { type: "test.passed", spec: sharedSpec, test: "B-test-2", duration_ms: 75 }),
    ]);

    // Run A: only A's tests; Run B: only B's tests.
    await expect.poll(async () => {
      const detail = await fetchRunDetail(page, token, runA);
      return detail.specs.flatMap((s) => s.tests).map((t) => t.title).sort();
    }, { timeout: 15_000, message: "run A should only contain A's tests" }).toEqual(["A-test-1", "A-test-2"]);

    await expect.poll(async () => {
      const detail = await fetchRunDetail(page, token, runB);
      return detail.specs.flatMap((s) => s.tests).map((t) => t.title).sort();
    }, { timeout: 15_000, message: "run B should only contain B's tests" }).toEqual(["B-test-1", "B-test-2"]);

    // The "B-only failure" error_message must NOT leak into run A's data.
    const detailA = await fetchRunDetail(page, token, runA);
    const detailAJson = JSON.stringify(detailA);
    expect(detailAJson).not.toContain("B-only failure");
    expect(detailAJson).not.toContain("B-test-1");
    expect(detailAJson).not.toContain("B-test-2");

    await Promise.all([
      postEvent(page, token, runA, { type: "run.finished", stats: { total: 2, passed: 2, failed: 0, skipped: 0 } }),
      postEvent(page, token, runB, { type: "run.finished", stats: { total: 2, passed: 1, failed: 1, skipped: 0 } }),
    ]);

    await deleteRun(page, token, runA);
    await deleteRun(page, token, runB);
  });

  test("Playwright run + Cypress run in parallel — different event schemas, both UIs render correctly", async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    // Playwright reporter: no spec.started/spec.finished; spec rows
    // materialise on the first test.started.
    const runPW = await startLive(page, token, `pw-par-${Date.now().toString(36)}`);
    // Cypress/Mocha reporter: full run.started → spec.started → test.* →
    // spec.finished → run.finished.
    const runCY = await startLive(page, token, `cy-par-${Date.now().toString(36)}`);

    // Same file path on purpose: simulates a shop that mirrors the
    // same auth tests across two stacks.
    const sharedSpec = "tests/auth/login.spec.ts";

    // Open BOTH run-detail pages in parallel browser tabs sharing the
    // same auth context — proves the SSE channel + 3s poll work in
    // parallel without one page seeing the other's events.
    await page.goto(`/runs/${runPW}`);
    const pageCY = await context.newPage();
    await pageCY.goto(`/runs/${runCY}`);

    await Promise.all([
      expect(page.locator(".live-badge")).toBeVisible({ timeout: POLL_TIMEOUT }),
      expect(pageCY.locator(".live-badge")).toBeVisible({ timeout: POLL_TIMEOUT }),
    ]);

    // Cypress shape on runCY (full lifecycle).
    await postEvent(page, token, runCY, { type: "run.started" });
    await postEvent(page, token, runCY, { type: "spec.started", spec: sharedSpec });

    // Playwright shape on runPW: emits run.started with a planned-test
    // count, no spec.started.
    await postEvent(page, token, runPW, {
      type: "run.started",
      stats: { total: 2, passed: 0, failed: 0, skipped: 0 },
    });

    // Interleaved test.starts. Each title is unique to its run so we
    // can prove each ends up in the right place.
    await Promise.all([
      postEvent(page, token, runPW, { type: "test.started", spec: sharedSpec, test: "PW-login" }),
      postEvent(page, token, runCY, { type: "test.started", spec: sharedSpec, test: "CY-login" }),
      postEvent(page, token, runPW, { type: "test.started", spec: sharedSpec, test: "PW-logout" }),
      postEvent(page, token, runCY, { type: "test.started", spec: sharedSpec, test: "CY-logout" }),
    ]);

    // Each tab shows its own pending count (>=2). Neither tab should
    // see the other's tests: 4 total events but 2 per tab.
    await Promise.all([
      expect.poll(async () => await page.locator(".test-status-dot.pending").count(), {
        timeout: 15_000, message: "Playwright run should show 2 pending dots",
      }).toBeGreaterThanOrEqual(2),
      expect.poll(async () => await pageCY.locator(".test-status-dot.pending").count(), {
        timeout: 15_000, message: "Cypress run should show 2 pending dots",
      }).toBeGreaterThanOrEqual(2),
    ]);

    // Each page must show EXACTLY 2 test rows — not 4. Catches a
    // regression where spec rows aren't scoped to runId.
    await expect.poll(
      async () => await page.locator(".test-row").count(),
      { timeout: 5_000, message: "Playwright page should show exactly 2 test rows" },
    ).toBe(2);
    await expect.poll(
      async () => await pageCY.locator(".test-row").count(),
      { timeout: 5_000, message: "Cypress page should show exactly 2 test rows" },
    ).toBe(2);

    // Drive each run to completion concurrently with mixed outcomes.
    await Promise.all([
      postEvent(page, token, runPW, { type: "test.passed", spec: sharedSpec, test: "PW-login", duration_ms: 800 }),
      postEvent(page, token, runCY, { type: "test.passed", spec: sharedSpec, test: "CY-login", duration_ms: 800 }),
    ]);
    await Promise.all([
      postEvent(page, token, runPW, { type: "test.failed", spec: sharedSpec, test: "PW-logout", duration_ms: 200, error: "PW: btn not visible" }),
      postEvent(page, token, runCY, { type: "test.failed", spec: sharedSpec, test: "CY-logout", duration_ms: 200, error: "CY: btn not visible" }),
    ]);

    await postEvent(page, token, runCY, {
      type: "spec.finished", spec: sharedSpec,
      stats: { total: 2, passed: 1, failed: 1, skipped: 0 },
    });

    await Promise.all([
      postEvent(page, token, runPW, { type: "run.finished" }),
      postEvent(page, token, runCY, { type: "run.finished" }),
    ]);

    // Both LIVE badges drop independently.
    await Promise.all([
      expect(page.locator(".live-badge")).toHaveCount(0, { timeout: POLL_TIMEOUT }),
      expect(pageCY.locator(".live-badge")).toHaveCount(0, { timeout: POLL_TIMEOUT }),
    ]);

    // API verification: each run owns ONLY its own tests, and the
    // failure error messages didn't bleed across.
    const detailPW = await fetchRunDetail(page, token, runPW);
    const detailCY = await fetchRunDetail(page, token, runCY);
    const titlesPW = detailPW.specs.flatMap((s) => s.tests).map((t) => t.title).sort();
    const titlesCY = detailCY.specs.flatMap((s) => s.tests).map((t) => t.title).sort();
    expect(titlesPW).toEqual(["PW-login", "PW-logout"]);
    expect(titlesCY).toEqual(["CY-login", "CY-logout"]);

    expect(JSON.stringify(detailPW)).not.toContain("CY: btn not visible");
    expect(JSON.stringify(detailCY)).not.toContain("PW: btn not visible");

    await pageCY.close();
    await deleteRun(page, token, runPW);
    await deleteRun(page, token, runCY);
  });

  test("/live/<id>/history feeds are isolated — no event from run B appears in run A's history", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);
    const runA = await startLive(page, token, `histA-${Date.now().toString(36)}`);
    const runB = await startLive(page, token, `histB-${Date.now().toString(36)}`);

    await Promise.all([
      postEvent(page, token, runA, { type: "spec.started", spec: "A-only.spec.ts" }),
      postEvent(page, token, runB, { type: "spec.started", spec: "B-only.spec.ts" }),
    ]);
    await Promise.all([
      postEvent(page, token, runA, { type: "test.started", spec: "A-only.spec.ts", test: "A-only-test" }),
      postEvent(page, token, runB, { type: "test.started", spec: "B-only.spec.ts", test: "B-only-test" }),
    ]);
    await Promise.all([
      postEvent(page, token, runA, { type: "test.passed", spec: "A-only.spec.ts", test: "A-only-test", duration_ms: 10 }),
      postEvent(page, token, runB, { type: "test.passed", spec: "B-only.spec.ts", test: "B-only-test", duration_ms: 20 }),
    ]);

    // /events returns 200 before its DB writes drain (events are processed
    // in the per-run async chain), so polling here lets each run's history
    // finish persisting before we assert on it. We're testing isolation,
    // not write latency.
    async function fetchHistory(runId: number): Promise<string> {
      const r = await page.request.get(`http://localhost:3000/live/${runId}/history`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(r.status()).toBe(200);
      return JSON.stringify(await r.json());
    }

    await expect.poll(() => fetchHistory(runA), { timeout: 10_000 })
      .toContain("A-only-test");
    await expect.poll(() => fetchHistory(runB), { timeout: 10_000 })
      .toContain("B-only-test");

    const histAJson = await fetchHistory(runA);
    const histBJson = await fetchHistory(runB);

    // A's history mentions A's spec/test and NEVER B's.
    expect(histAJson).toContain("A-only.spec.ts");
    expect(histAJson).toContain("A-only-test");
    expect(histAJson).not.toContain("B-only.spec.ts");
    expect(histAJson).not.toContain("B-only-test");

    // And vice versa.
    expect(histBJson).toContain("B-only.spec.ts");
    expect(histBJson).toContain("B-only-test");
    expect(histBJson).not.toContain("A-only.spec.ts");
    expect(histBJson).not.toContain("A-only-test");

    await Promise.all([
      postEvent(page, token, runA, { type: "run.finished" }),
      postEvent(page, token, runB, { type: "run.finished" }),
    ]);
    await deleteRun(page, token, runA);
    await deleteRun(page, token, runB);
  });

  test("screenshot uploaded to run A does NOT attach to run B's same-titled test", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);
    const runA = await startLive(page, token, `ssA-${Date.now().toString(36)}`);
    const runB = await startLive(page, token, `ssB-${Date.now().toString(36)}`);

    // Adversarial setup: same spec path AND same test title in both runs.
    const sharedSpec = "tests/auth/login.spec.ts";
    const sharedTitle = "should login successfully";

    await Promise.all([
      postEvent(page, token, runA, { type: "spec.started", spec: sharedSpec }),
      postEvent(page, token, runB, { type: "spec.started", spec: sharedSpec }),
    ]);
    await Promise.all([
      postEvent(page, token, runA, { type: "test.started", spec: sharedSpec, test: sharedTitle }),
      postEvent(page, token, runB, { type: "test.started", spec: sharedSpec, test: sharedTitle }),
    ]);

    // Minimal valid 1×1 PNG.
    const minimalPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    // Upload to run A only.
    const ssRes = await page.request.post(
      `http://localhost:3000/live/${runA}/screenshot`,
      {
        headers: { Authorization: `Bearer ${token}` },
        multipart: {
          screenshot: { name: "isolation.png", mimeType: "image/png", buffer: minimalPng },
          spec: sharedSpec,
          testTitle: sharedTitle,
        },
      },
    );
    expect(ssRes.status()).toBe(200);

    // A's row gains a screenshot.
    await expect.poll(async () => {
      const detail = await fetchRunDetail(page, token, runA);
      const t = detail.specs.flatMap((s) => s.tests).find((x) => x.title === sharedTitle);
      return t?.screenshot_paths?.length ?? 0;
    }, { timeout: 15_000, message: "run A's test should gain the screenshot" }).toBeGreaterThanOrEqual(1);

    // B's row has zero screenshots — proves the UPDATE was scoped by
    // specs.run_id and didn't widen on title match.
    const detailB = await fetchRunDetail(page, token, runB);
    const tB = detailB.specs.flatMap((s) => s.tests).find((x) => x.title === sharedTitle);
    expect(tB, "B's same-titled test should still exist").toBeTruthy();
    expect(tB?.screenshot_paths ?? []).toEqual([]);

    // Belt-and-braces: the screenshot key embeds runA's id, so it must
    // not appear anywhere in run B's detail JSON.
    const detailBJson = JSON.stringify(detailB);
    expect(detailBJson).not.toContain(`runs/${runA}/screenshots/`);

    await Promise.all([
      postEvent(page, token, runA, { type: "run.finished" }),
      postEvent(page, token, runB, { type: "run.finished" }),
    ]);
    await deleteRun(page, token, runA);
    await deleteRun(page, token, runB);
  });
});
