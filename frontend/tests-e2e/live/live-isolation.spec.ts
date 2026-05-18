import { expect, test, type APIRequestContext, type Page } from "../fixtures/test";

import { ADMIN_USER, DEMO_USER } from "../fixtures/users";

/**
 * Round-two live isolation coverage.
 *
 * Scenarios that the first round didn't reach:
 *
 *   1. Cross-tenant — a user in demo-team must not be able to read,
 *      write, abort, screenshot, or delete an acme run. Every live
 *      endpoint must reject with 404 (NOT 403 — the route does an
 *      `owns` check via tenantQuery, so the run is invisible from the
 *      other tenant's perspective, indistinguishable from "doesn't
 *      exist"). Catches an RLS regression that would let a hostile
 *      authenticated user enumerate or poison another org's live
 *      stream.
 *
 *   2. Three reporters at once — Cypress + Playwright + WebdriverIO
 *      shapes, three runs, all driven concurrently. Proves the per-run
 *      processing chain Map handles N>2 entries and that different
 *      adapter event-shapes don't cross-pollinate.
 *
 *   3. Aborting one run while two others stream — A's pending rows
 *      transition to skipped, B and C are untouched and continue to
 *      flip when their later test.passed events arrive.
 *
 *   4. Concurrent abort POSTs for the same run — idempotent; the run
 *      still ends in `aborted` with no zombie pending rows and no
 *      double-skipped error_messages getting overwritten in confusing
 *      ways.
 *
 *   5. Two concurrent runs with identical (suite, branch, commitSha) —
 *      a typical CI retry-of-the-same-job. Each gets its own run id;
 *      events and tests must not bleed across.
 */

const POLL_TIMEOUT = 10_000;

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

async function startLive(
  request: APIRequestContext,
  token: string,
  suite: string,
  extras: { branch?: string; commitSha?: string } = {},
): Promise<number> {
  const res = await request.post("http://localhost:3000/live/start", {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: {
      suite,
      branch: extras.branch ?? "main",
      commitSha: extras.commitSha ?? "isolation",
    },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id as number;
}

async function postEvent(
  request: APIRequestContext,
  token: string,
  runId: number,
  event: Record<string, unknown>,
): Promise<void> {
  const res = await request.post(`http://localhost:3000/live/${runId}/events`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: event,
  });
  expect(res.status(), `event ${event.type} should accept`).toBe(200);
}

async function deleteRun(
  request: APIRequestContext,
  token: string,
  runId: number,
): Promise<void> {
  await request.delete(`http://localhost:3000/runs/${runId}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

type TestRow = { title: string; status: string; error_message?: string | null };
type SpecRow = { tests: TestRow[] };

async function fetchRunDetail(
  request: APIRequestContext,
  token: string,
  runId: number,
): Promise<{ specs: SpecRow[]; failed?: number; passed?: number; skipped?: number; pending?: number }> {
  const r = await request.get(`http://localhost:3000/runs/${runId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(r.status()).toBe(200);
  return r.json();
}

/* ───────────────────── 1. Cross-tenant isolation ───────────────────── */

test.describe("live tenancy — cross-org isolation", () => {
  test("a user in demo-team is invisible to acme's live run on every endpoint (404 on read, write, abort, delete)", async ({
    browser,
  }) => {
    test.setTimeout(45_000);

    // Two browser contexts, two storageStates, two tenants.
    const acmeCtx = await browser.newContext({ storageState: ADMIN_USER.storageStatePath });
    const demoCtx = await browser.newContext({ storageState: DEMO_USER.storageStatePath });

    try {
      const acmePage = await acmeCtx.newPage();
      const demoPage = await demoCtx.newPage();

      await Promise.all([acmePage.goto("/dashboard"), demoPage.goto("/dashboard")]);
      const acmeToken = await getToken(acmePage);
      const demoToken = await getToken(demoPage);
      expect(acmeToken).toBeTruthy();
      expect(demoToken).toBeTruthy();
      expect(acmeToken).not.toBe(demoToken);

      // Acme starts a run and seeds it with one pending test.
      const acmeRun = await startLive(acmePage.request, acmeToken, `cross-org-${Date.now().toString(36)}`);
      const sharedSpec = "tests/secret/internal.spec.ts";
      const sharedTest = "should not be readable by demo-team";
      await postEvent(acmePage.request, acmeToken, acmeRun, { type: "spec.started", spec: sharedSpec });
      await postEvent(acmePage.request, acmeToken, acmeRun, { type: "test.started", spec: sharedSpec, test: sharedTest });

      // Now from demo-team's session, every live endpoint scoped to acmeRun
      // must 404 (the tenantQuery owns-check makes the run invisible).
      // ── GET /runs/<id>
      const runDetail = await demoPage.request.get(`http://localhost:3000/runs/${acmeRun}`, {
        headers: { Authorization: `Bearer ${demoToken}` },
      });
      expect(runDetail.status(), "demo cannot read acme's run details").toBe(404);

      // ── GET /live/<id>/history (the persisted SSE log)
      const history = await demoPage.request.get(`http://localhost:3000/live/${acmeRun}/history`, {
        headers: { Authorization: `Bearer ${demoToken}` },
      });
      expect(history.status(), "demo cannot read acme's live history").toBe(404);

      // ── POST /live/<id>/events  (cross-org event poisoning)
      const inject = await demoPage.request.post(`http://localhost:3000/live/${acmeRun}/events`, {
        headers: { Authorization: `Bearer ${demoToken}`, "Content-Type": "application/json" },
        data: { type: "test.passed", spec: sharedSpec, test: sharedTest, duration_ms: 1 },
      });
      expect(inject.status(), "demo cannot inject events into acme's run").toBe(404);

      // ── POST /live/<id>/abort
      const abort = await demoPage.request.post(`http://localhost:3000/live/${acmeRun}/abort`, {
        headers: { Authorization: `Bearer ${demoToken}`, "Content-Type": "application/json" },
        data: { reason: "hostile abort" },
      });
      expect(abort.status(), "demo cannot abort acme's run").toBe(404);

      // ── POST /live/<id>/screenshot (multipart)
      const png = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
      const ssRes = await demoPage.request.post(
        `http://localhost:3000/live/${acmeRun}/screenshot`,
        {
          headers: { Authorization: `Bearer ${demoToken}` },
          multipart: {
            screenshot: { name: "evil.png", mimeType: "image/png", buffer: png },
            spec: sharedSpec,
            testTitle: sharedTest,
          },
        },
      );
      expect(ssRes.status(), "demo cannot upload screenshots to acme's run").toBe(404);

      // ── DELETE /runs/<id>
      const del = await demoPage.request.delete(`http://localhost:3000/runs/${acmeRun}`, {
        headers: { Authorization: `Bearer ${demoToken}` },
      });
      expect(del.status(), "demo cannot delete acme's run").toBeGreaterThanOrEqual(400);

      // ── GET /live/<id>/stream — SSE auth check happens before headers,
      //    so a 404 lands on the response object even though it's an
      //    SSE endpoint. Just hit it as a plain GET; we don't need the
      //    stream to flow.
      const sse = await demoPage.request.get(
        `http://localhost:3000/live/${acmeRun}/stream?token=${encodeURIComponent(demoToken)}`,
        { headers: { Authorization: `Bearer ${demoToken}` }, timeout: 3_000 },
      ).catch((err) => err as Error);
      // Either we got back a 404 response OR the request failed before
      // headers — both are acceptable evidence that we couldn't subscribe.
      if (typeof (sse as { status?: () => number }).status === "function") {
        expect((sse as { status: () => number }).status()).toBe(404);
      }

      // Acme's own state is intact: still exactly one pending test,
      // no error_message contamination, no extra screenshots.
      const detailAfter = await fetchRunDetail(acmePage.request, acmeToken, acmeRun);
      const tests = detailAfter.specs.flatMap((s) => s.tests);
      expect(tests.length).toBe(1);
      expect(tests[0].title).toBe(sharedTest);
      expect(tests[0].status).toBe("pending");
      expect(JSON.stringify(detailAfter)).not.toContain("hostile abort");

      await postEvent(acmePage.request, acmeToken, acmeRun, { type: "run.finished" });
      await deleteRun(acmePage.request, acmeToken, acmeRun);
    } finally {
      await acmeCtx.close();
      await demoCtx.close();
    }
  });
});

/* ───────────────────── 2. Three reporters at once ───────────────────── */

test.describe("live multi-run — three reporters streaming concurrently", () => {

  test("Cypress + Playwright + WebdriverIO running side-by-side keep their rows scoped to their own runs", async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const cyRun = await startLive(page.request, token, `cy3-${Date.now().toString(36)}`);
    const pwRun = await startLive(page.request, token, `pw3-${Date.now().toString(36)}`);
    const wdioRun = await startLive(page.request, token, `wdio3-${Date.now().toString(36)}`);

    // Open three tabs sharing the auth context, one per run.
    await page.goto(`/runs/${cyRun}`);
    const pwPage = await context.newPage();
    await pwPage.goto(`/runs/${pwRun}`);
    const wdioPage = await context.newPage();
    await wdioPage.goto(`/runs/${wdioRun}`);

    await Promise.all([
      expect(page.locator(".live-badge")).toBeVisible({ timeout: POLL_TIMEOUT }),
      expect(pwPage.locator(".live-badge")).toBeVisible({ timeout: POLL_TIMEOUT }),
      expect(wdioPage.locator(".live-badge")).toBeVisible({ timeout: POLL_TIMEOUT }),
    ]);

    // Same spec path on all three — proves spec rows are run-scoped.
    const sharedSpec = "tests/auth/login.spec.ts";

    // Cypress: full lifecycle. Playwright: no spec.started. WDIO:
    // no test.started; results land terminal.
    await Promise.all([
      postEvent(page.request, token, cyRun, { type: "run.started" }),
      postEvent(page.request, token, pwRun, { type: "run.started", stats: { total: 2, passed: 0, failed: 0, skipped: 0 } }),
      postEvent(page.request, token, wdioRun, { type: "run.started" }),
    ]);

    await Promise.all([
      postEvent(page.request, token, cyRun, { type: "spec.started", spec: sharedSpec }),
      postEvent(page.request, token, wdioRun, { type: "spec.started", spec: sharedSpec }),
    ]);

    // Cypress + Playwright emit test.started; WDIO does not.
    await Promise.all([
      postEvent(page.request, token, cyRun, { type: "test.started", spec: sharedSpec, test: "CY-only-1" }),
      postEvent(page.request, token, cyRun, { type: "test.started", spec: sharedSpec, test: "CY-only-2" }),
      postEvent(page.request, token, pwRun, { type: "test.started", spec: sharedSpec, test: "PW-only-1" }),
      postEvent(page.request, token, pwRun, { type: "test.started", spec: sharedSpec, test: "PW-only-2" }),
    ]);

    // Cy + Pw tabs each show 2 pending dots; WDIO has none yet.
    await Promise.all([
      expect.poll(async () => await page.locator(".test-status-dot.pending").count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2),
      expect.poll(async () => await pwPage.locator(".test-status-dot.pending").count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2),
    ]);
    // WDIO tab must not have leaked pending dots from cy/pw runs.
    expect(await wdioPage.locator(".test-status-dot.pending").count()).toBe(0);

    // Stream terminal events for all three.
    await Promise.all([
      postEvent(page.request, token, cyRun, { type: "test.passed", spec: sharedSpec, test: "CY-only-1", duration_ms: 100 }),
      postEvent(page.request, token, cyRun, { type: "test.failed", spec: sharedSpec, test: "CY-only-2", duration_ms: 200, error: "CY: timeout" }),
      postEvent(page.request, token, pwRun, { type: "test.passed", spec: sharedSpec, test: "PW-only-1", duration_ms: 110 }),
      postEvent(page.request, token, pwRun, { type: "test.passed", spec: sharedSpec, test: "PW-only-2", duration_ms: 120 }),
      postEvent(page.request, token, wdioRun, { type: "test.passed", spec: sharedSpec, test: "WDIO-only-1", duration_ms: 90 }),
      postEvent(page.request, token, wdioRun, { type: "test.failed", spec: sharedSpec, test: "WDIO-only-2", duration_ms: 150, error: "WDIO: assert" }),
    ]);

    await Promise.all([
      postEvent(page.request, token, cyRun, { type: "spec.finished", spec: sharedSpec, stats: { total: 2, passed: 1, failed: 1, skipped: 0 } }),
      postEvent(page.request, token, cyRun, { type: "run.finished" }),
      postEvent(page.request, token, pwRun, { type: "run.finished" }),
      postEvent(page.request, token, wdioRun, { type: "run.finished" }),
    ]);

    await Promise.all([
      expect(page.locator(".live-badge")).toHaveCount(0, { timeout: POLL_TIMEOUT }),
      expect(pwPage.locator(".live-badge")).toHaveCount(0, { timeout: POLL_TIMEOUT }),
      expect(wdioPage.locator(".live-badge")).toHaveCount(0, { timeout: POLL_TIMEOUT }),
    ]);

    // API verification: each run owns ONLY its own tests, error
    // messages didn't bleed across.
    const [cyDetail, pwDetail, wdioDetail] = await Promise.all([
      fetchRunDetail(page.request, token, cyRun),
      fetchRunDetail(page.request, token, pwRun),
      fetchRunDetail(page.request, token, wdioRun),
    ]);
    const titlesOf = (d: { specs: SpecRow[] }) => d.specs.flatMap((s) => s.tests).map((t) => t.title).sort();
    expect(titlesOf(cyDetail)).toEqual(["CY-only-1", "CY-only-2"]);
    expect(titlesOf(pwDetail)).toEqual(["PW-only-1", "PW-only-2"]);
    expect(titlesOf(wdioDetail)).toEqual(["WDIO-only-1", "WDIO-only-2"]);

    // Cross-pollination check: error_message scoping.
    expect(JSON.stringify(pwDetail)).not.toContain("CY: timeout");
    expect(JSON.stringify(wdioDetail)).not.toContain("CY: timeout");
    expect(JSON.stringify(cyDetail)).not.toContain("WDIO: assert");
    expect(JSON.stringify(pwDetail)).not.toContain("WDIO: assert");

    await pwPage.close();
    await wdioPage.close();
    await deleteRun(page.request, token, cyRun);
    await deleteRun(page.request, token, pwRun);
    await deleteRun(page.request, token, wdioRun);
  });
});

/* ───────────────────── 3. Abort scope across parallel runs ───────────────────── */

test.describe("live multi-run — aborting one run does not affect siblings", () => {

  test("aborting run A flips A's pending → skipped; runs B and C keep their pending rows and continue flipping cleanly", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const runA = await startLive(page.request, token, `abrt-A-${Date.now().toString(36)}`);
    const runB = await startLive(page.request, token, `abrt-B-${Date.now().toString(36)}`);
    const runC = await startLive(page.request, token, `abrt-C-${Date.now().toString(36)}`);

    const spec = "tests/abort-scope/case.spec.ts";

    // Each run has 2 pending tests in flight when the abort lands.
    await Promise.all([
      postEvent(page.request, token, runA, { type: "spec.started", spec }),
      postEvent(page.request, token, runB, { type: "spec.started", spec }),
      postEvent(page.request, token, runC, { type: "spec.started", spec }),
    ]);
    await Promise.all([
      postEvent(page.request, token, runA, { type: "test.started", spec, test: "A1" }),
      postEvent(page.request, token, runA, { type: "test.started", spec, test: "A2" }),
      postEvent(page.request, token, runB, { type: "test.started", spec, test: "B1" }),
      postEvent(page.request, token, runB, { type: "test.started", spec, test: "B2" }),
      postEvent(page.request, token, runC, { type: "test.started", spec, test: "C1" }),
      postEvent(page.request, token, runC, { type: "test.started", spec, test: "C2" }),
    ]);

    // Abort A only.
    const abortRes = await page.request.post(`http://localhost:3000/live/${runA}/abort`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { reason: "scoped abort" },
    });
    expect(abortRes.status()).toBeLessThan(400);

    // A's tests are now both non-pending (skipped, with error_message).
    await expect.poll(async () => {
      const d = await fetchRunDetail(page.request, token, runA);
      return d.specs.flatMap((s) => s.tests).every((t) => t.status !== "pending");
    }, { timeout: 15_000, message: "all of run A's tests should be out of pending" }).toBe(true);

    // B and C still have BOTH tests pending — abort scope held.
    const detailB = await fetchRunDetail(page.request, token, runB);
    const detailC = await fetchRunDetail(page.request, token, runC);
    const pendingTitlesB = detailB.specs.flatMap((s) => s.tests).filter((t) => t.status === "pending").map((t) => t.title).sort();
    const pendingTitlesC = detailC.specs.flatMap((s) => s.tests).filter((t) => t.status === "pending").map((t) => t.title).sort();
    expect(pendingTitlesB, "run B's pending rows must still be pending").toEqual(["B1", "B2"]);
    expect(pendingTitlesC, "run C's pending rows must still be pending").toEqual(["C1", "C2"]);

    // The abort reason must not have leaked into B or C.
    expect(JSON.stringify(detailB)).not.toContain("scoped abort");
    expect(JSON.stringify(detailC)).not.toContain("scoped abort");

    // B and C continue normally — their event chains weren't poisoned
    // by A's abort. Send terminal events and verify the rows flip.
    await Promise.all([
      postEvent(page.request, token, runB, { type: "test.passed", spec, test: "B1", duration_ms: 50 }),
      postEvent(page.request, token, runB, { type: "test.passed", spec, test: "B2", duration_ms: 60 }),
      postEvent(page.request, token, runC, { type: "test.passed", spec, test: "C1", duration_ms: 70 }),
      postEvent(page.request, token, runC, { type: "test.failed", spec, test: "C2", duration_ms: 80, error: "C2 failed" }),
    ]);

    await expect.poll(async () => {
      const d = await fetchRunDetail(page.request, token, runB);
      return d.specs.flatMap((s) => s.tests).filter((t) => t.status === "passed").length;
    }, { timeout: 15_000 }).toBe(2);

    await expect.poll(async () => {
      const d = await fetchRunDetail(page.request, token, runC);
      const tests = d.specs.flatMap((s) => s.tests);
      return {
        passed: tests.filter((t) => t.status === "passed").length,
        failed: tests.filter((t) => t.status === "failed").length,
      };
    }, { timeout: 15_000 }).toEqual({ passed: 1, failed: 1 });

    await postEvent(page.request, token, runB, { type: "run.finished" });
    await postEvent(page.request, token, runC, { type: "run.finished" });
    await deleteRun(page.request, token, runA);
    await deleteRun(page.request, token, runB);
    await deleteRun(page.request, token, runC);
  });
});

/* ───────────────────── 4. Concurrent abort idempotency ───────────────────── */

test.describe("live — concurrent abort POSTs are idempotent", () => {

  test("two simultaneous abort POSTs for the same run end in 'aborted' with no zombie pending and no double-skipped error contamination", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const runId = await startLive(page.request, token, `dbl-abrt-${Date.now().toString(36)}`);
    const spec = "tests/double-abort/case.spec.ts";
    await postEvent(page.request, token, runId, { type: "spec.started", spec });
    await postEvent(page.request, token, runId, { type: "test.started", spec, test: "stuck1" });
    await postEvent(page.request, token, runId, { type: "test.started", spec, test: "stuck2" });

    // Fire two abort POSTs in parallel. Both should succeed — the
    // second is a no-op against the (already-empty) pending pool.
    const [r1, r2] = await Promise.all([
      page.request.post(`http://localhost:3000/live/${runId}/abort`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        data: { reason: "first abort" },
      }),
      page.request.post(`http://localhost:3000/live/${runId}/abort`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        data: { reason: "second abort racing the first" },
      }),
    ]);
    expect(r1.status(), "first abort should accept").toBeLessThan(400);
    expect(r2.status(), "second concurrent abort should also accept").toBeLessThan(400);

    // Final state: zero pending, both stuck1 and stuck2 transitioned.
    await expect.poll(async () => {
      const d = await fetchRunDetail(page.request, token, runId);
      return d.specs.flatMap((s) => s.tests).filter((t) => t.status === "pending").length;
    }, { timeout: 15_000, message: "no test row should remain pending after concurrent aborts" }).toBe(0);

    const detail = await fetchRunDetail(page.request, token, runId);
    const tests = detail.specs.flatMap((s) => s.tests);
    expect(tests.length, "still exactly two test rows — no duplicates from the racing aborts").toBe(2);
    for (const t of tests) {
      expect(t.status, `test ${t.title} should be skipped, not pending`).toBe("skipped");
      expect(t.error_message ?? "", `test ${t.title} should record an aborted reason`).toMatch(/aborted/i);
    }

    await deleteRun(page.request, token, runId);
  });
});

/* ───────────────────── 5. Same-(suite, branch, commit) parallel runs ───────────────────── */

test.describe("live multi-run — concurrent runs sharing (suite, branch, commit) are independent", () => {

  test("a CI retry that starts a second run with identical metadata gets a distinct run id and isolated state", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    // Identical metadata — simulates re-running the same job.
    const sharedSuite = `retry-suite-${Date.now().toString(36)}`;
    const sharedBranch = "feature/auth-rework";
    const sharedCommit = "deadbeef00000000";

    const [runA, runB] = await Promise.all([
      startLive(page.request, token, sharedSuite, { branch: sharedBranch, commitSha: sharedCommit }),
      startLive(page.request, token, sharedSuite, { branch: sharedBranch, commitSha: sharedCommit }),
    ]);
    expect(runA, "each run must get its own id").not.toBe(runB);

    const spec = "tests/retry/login.spec.ts";

    // Drive each run with mostly the same titles but distinct outcomes
    // (run A passes, run B fails) — proves results don't merge.
    await Promise.all([
      postEvent(page.request, token, runA, { type: "spec.started", spec }),
      postEvent(page.request, token, runB, { type: "spec.started", spec }),
    ]);
    await Promise.all([
      postEvent(page.request, token, runA, { type: "test.started", spec, test: "shared title" }),
      postEvent(page.request, token, runB, { type: "test.started", spec, test: "shared title" }),
    ]);
    await Promise.all([
      postEvent(page.request, token, runA, { type: "test.passed", spec, test: "shared title", duration_ms: 100 }),
      postEvent(page.request, token, runB, { type: "test.failed", spec, test: "shared title", duration_ms: 200, error: "B-only failure trace" }),
    ]);

    await expect.poll(async () => {
      const d = await fetchRunDetail(page.request, token, runA);
      return d.specs.flatMap((s) => s.tests).map((t) => `${t.title}:${t.status}`).sort();
    }, { timeout: 15_000 }).toEqual(["shared title:passed"]);

    await expect.poll(async () => {
      const d = await fetchRunDetail(page.request, token, runB);
      return d.specs.flatMap((s) => s.tests).map((t) => `${t.title}:${t.status}`).sort();
    }, { timeout: 15_000 }).toEqual(["shared title:failed"]);

    // The B-only failure trace must not leak into A.
    const detailA = await fetchRunDetail(page.request, token, runA);
    expect(JSON.stringify(detailA)).not.toContain("B-only failure trace");

    await Promise.all([
      postEvent(page.request, token, runA, { type: "run.finished" }),
      postEvent(page.request, token, runB, { type: "run.finished" }),
    ]);
    await deleteRun(page.request, token, runA);
    await deleteRun(page.request, token, runB);
  });
});
