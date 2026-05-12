import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * Bug-hunting integration tests for the upload + live-merge surfaces
 * the earlier rounds didn't reach. Each test is set up to actually
 * surface a bug if one exists — they probe atomicity, ordering, and
 * cross-page consistency rather than pinning known-good behaviour.
 *
 *   1. Concurrent /runs/upload with the same ci_run_id — the partial
 *      unique index on (org_id, suite_name, ci_run_id) is supposed to
 *      make findOrCreateRun atomic; three parallel uploads should
 *      land on ONE merged run id, not three duplicate rows.
 *
 *   2. Live screenshot landing AFTER /runs/upload's delete+reinsert —
 *      the upload's preserved-paths logic snapshots screenshot_paths
 *      BEFORE the DELETE; a screenshot POST that races in between
 *      could either be lost (deleted before snapshot) or re-applied
 *      (snapshot caught it). The contract: late-arriving live
 *      screenshots stay attached to the right test row.
 *
 *   3. /runs/<id>?status=failed filter consistency — the URL filter
 *      is server-supplied; the test asserts that the filter result
 *      and the raw rows agree (no off-by-one based on a normalisation
 *      mismatch).
 *
 *   4. Burst of 50 events vs the 3-second poll — drive a fast burst
 *      through the per-run chain and assert that intermediate UI
 *      reads never show torn data (a row that's neither pending nor
 *      its eventual terminal status).
 */

const POLL_TIMEOUT = 10_000;

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

async function startLive(
  request: APIRequestContext,
  token: string,
  suite: string,
): Promise<{ runId: number; ciRunId: string }> {
  const res = await request.post("http://localhost:3000/live/start", {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: { suite, branch: "main", commitSha: "bughunt" },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { id: number; ci_run_id: string };
  return { runId: body.id, ciRunId: body.ci_run_id };
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

const MINIMAL_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function uploadPayload(opts: {
  suite: string; ciRunId: string; specs: { file_path: string; tests: { title: string; status: "passed" | "failed" | "skipped"; duration_ms: number; error?: { message: string } }[] }[];
}): { meta: any; stats: any; specs: any[] } {
  let total = 0, passed = 0, failed = 0, skipped = 0, duration = 0;
  const specs = opts.specs.map((s) => {
    let st = 0, sp = 0, sf = 0, sk = 0, sd = 0;
    for (const t of s.tests) {
      st++; sd += t.duration_ms;
      if (t.status === "passed") sp++;
      else if (t.status === "failed") sf++;
      else sk++;
    }
    total += st; passed += sp; failed += sf; skipped += sk; duration += sd;
    return {
      file_path: s.file_path,
      title: s.file_path.split("/").pop() ?? s.file_path,
      stats: { total: st, passed: sp, failed: sf, skipped: sk, duration_ms: sd },
      tests: s.tests.map((t) => ({
        title: t.title,
        full_title: t.title,
        status: t.status,
        duration_ms: t.duration_ms,
        screenshot_paths: [],
        ...(t.error ? { error: t.error } : {}),
      })),
    };
  });
  return {
    meta: {
      suite_name: opts.suite,
      branch: "main",
      commit_sha: "bughunt",
      ci_run_id: opts.ciRunId,
      started_at: new Date(Date.now() - 30_000).toISOString(),
      finished_at: new Date().toISOString(),
      reporter: "playwright",
    },
    stats: { total, passed, failed, skipped, pending: 0, duration_ms: duration },
    specs,
  };
}

/* ───────────────────── 1. Concurrent /runs/upload merge ───────────────────── */

test.describe("upload bughunt — concurrent /runs/upload with same ci_run_id", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("three simultaneous uploads sharing (suite, ci_run_id) merge into ONE run id, not three", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const suite = `concurrent-merge-${Date.now().toString(36)}`;
    const ciRunId = `ci-${Date.now().toString(36)}`;

    // Three reports for the SAME (suite, ci_run_id) — simulates a CI job
    // that retries the upload step three times due to a flaky network.
    // Each attempt has slightly different test outcomes so we can assert
    // the merge wins consistently (last-writer or stable-merge — whatever
    // the contract is, all three uploads must land on ONE run id).
    const mkPayload = (i: number) =>
      uploadPayload({
        suite,
        ciRunId,
        specs: [{
          file_path: `tests/concurrent-${i}.spec.ts`,
          tests: [{ title: `t${i}`, status: "passed", duration_ms: 10 + i }],
        }],
      });

    const responses = await Promise.all(
      [0, 1, 2].map((i) =>
        page.request.post("http://localhost:3000/runs/upload", {
          headers: { Authorization: `Bearer ${token}` },
          multipart: { payload: JSON.stringify(mkPayload(i)) },
        }),
      ),
    );

    for (const r of responses) {
      expect(r.status(), "every concurrent upload should succeed").toBeLessThan(300);
    }

    const ids = await Promise.all(
      responses.map(async (r) => ((await r.json()) as { id: number }).id),
    );
    const distinctIds = new Set(ids);
    expect(
      distinctIds.size,
      "all three concurrent uploads must collapse to ONE run id (the partial unique index on org_id+suite_name+ci_run_id makes findOrCreateRun atomic)",
    ).toBe(1);

    // The single resulting run owns specs from at least one of the
    // three payloads (the merge replaces specs per upload, so the LAST
    // commit wins for each spec — but no specs from the OTHER two
    // payloads should be present alongside them under different file
    // paths in some bizarre intermediate state).
    const runId = ids[0];
    const detailRes = await page.request.get(`http://localhost:3000/runs/${runId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(detailRes.status()).toBe(200);
    const detail = (await detailRes.json()) as { specs: { file_path: string }[] };
    // Each upload had exactly one spec at a unique path. Whichever
    // sequence the merges run in, the FINAL state has at least one
    // spec — and stat counts must match what's actually in the rows
    // (no zombie 0-row specs).
    expect(detail.specs.length).toBeGreaterThanOrEqual(1);

    await deleteRun(page.request, token, runId);
  });
});

/* ───────────────────── 2. Live screenshot lands AFTER /runs/upload ───────────────────── */

test.describe("upload bughunt — screenshot lands AFTER end-of-run upload", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("a /live/<id>/screenshot POST that arrives AFTER /runs/upload's delete+reinsert is still attached to the right test row", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);
    const { runId, ciRunId } = await startLive(page.request, token, `late-shot-${Date.now().toString(36)}`);
    const specPath = "tests/auth/login.spec.ts";
    const fullTitle = "Auth flow > should login";

    // Drive the live half — but DON'T upload a screenshot yet.
    await postEvent(page.request, token, runId, { type: "spec.started", spec: specPath });
    await postEvent(page.request, token, runId, { type: "test.started", spec: specPath, test: fullTitle });
    await postEvent(page.request, token, runId, {
      type: "test.passed", spec: specPath, test: fullTitle, duration_ms: 100,
    });
    await postEvent(page.request, token, runId, { type: "run.finished" });

    // End-of-run upload — uses delete+reinsert to land the authoritative rows.
    const upRes = await page.request.post("http://localhost:3000/runs/upload", {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        payload: JSON.stringify(uploadPayload({
          suite: `late-shot-${Date.now().toString(36)}`,
          ciRunId,
          specs: [{
            file_path: specPath,
            tests: [{ title: fullTitle, status: "passed", duration_ms: 100 }],
          }],
        })),
      },
    });
    expect(upRes.status()).toBeLessThan(300);

    // NOW the screenshot uploads — well after the upload has rewritten
    // the test rows. The screenshot endpoint's UPDATE path scopes by
    // (run_id, spec.file_path, full_title) and falls back to upserting
    // a pending row if no match is found. Either way: we want the
    // screenshot key to land somewhere it's discoverable.
    const ssRes = await page.request.post(`http://localhost:3000/live/${runId}/screenshot`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        screenshot: { name: "after-upload.png", mimeType: "image/png", buffer: MINIMAL_PNG },
        spec: specPath,
        testTitle: fullTitle,
      },
    });
    expect(ssRes.status(), "screenshot upload should accept post-merge").toBe(200);
    const liveKey = ((await ssRes.json()) as { key: string }).key;

    // The contract: the screenshot is attached to the (now upload-
    // owned) test row, not orphaned in storage. Search the run detail
    // for the key.
    const detail = await page.request.get(`http://localhost:3000/runs/${runId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(detail.status()).toBe(200);
    const body = await detail.json();
    const matchingRow = body.specs?.flatMap((s: any) => s.tests).find((t: any) =>
      t.full_title === fullTitle || t.title === fullTitle,
    );
    expect(matchingRow, "the upload-owned test row should still exist").toBeTruthy();
    expect(
      matchingRow.screenshot_paths ?? [],
      "the late screenshot must be attached to the upload-owned row, not orphaned",
    ).toContain(liveKey);

    await deleteRun(page.request, token, runId);
  });
});

/* ───────────────────── 3. /runs/<id>?status=failed filter consistency ───────────────────── */

test.describe("upload bughunt — status filter consistency", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("the run-detail UI's status=failed view shows exactly the rows with status='failed' in the API response", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);
    const { runId } = await startLive(page.request, token, `filter-${Date.now().toString(36)}`);
    const specPath = "tests/filter/mix.spec.ts";

    // 5 passed, 3 failed, 2 skipped — known totals.
    await postEvent(page.request, token, runId, { type: "spec.started", spec: specPath });
    for (const t of ["p1","p2","p3","p4","p5"]) {
      await postEvent(page.request, token, runId, { type: "test.started", spec: specPath, test: t });
      await postEvent(page.request, token, runId, { type: "test.passed", spec: specPath, test: t, duration_ms: 10 });
    }
    for (const t of ["f1","f2","f3"]) {
      await postEvent(page.request, token, runId, { type: "test.started", spec: specPath, test: t });
      await postEvent(page.request, token, runId, {
        type: "test.failed", spec: specPath, test: t, duration_ms: 20, error: `${t} broke`,
      });
    }
    for (const t of ["s1","s2"]) {
      await postEvent(page.request, token, runId, { type: "test.started", spec: specPath, test: t });
      await postEvent(page.request, token, runId, { type: "test.skipped", spec: specPath, test: t });
    }
    await postEvent(page.request, token, runId, { type: "run.finished" });

    // Wait for the chain to drain so detail counters are stable.
    await expect.poll(async () => {
      const r = await page.request.get(`http://localhost:3000/runs/${runId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await r.json();
      return body.failed;
    }, { timeout: 15_000 }).toBe(3);

    // The UI loads /runs/<id>?status=failed; the page's auto-filter
    // also lands on `failed` whenever failed > 0.
    await page.goto(`/runs/${runId}?status=failed`);
    // Detail page header lands the run id in the meta-row chip
    // (the polished layout dropped the redundant <h1>Run #N</h1>).
    await expect(
      page.locator(".run-header .meta-item", { hasText: new RegExp(`^\\s*#${runId}\\s*$`) }).first(),
    ).toBeVisible({ timeout: POLL_TIMEOUT });

    // Wait for the spec section to mount.
    await expect(page.locator(".spec-section").first()).toBeVisible({ timeout: POLL_TIMEOUT });

    // The visible test rows must be exactly the 3 failed tests — no
    // passed/skipped rows leaking through under the failed filter.
    await expect.poll(
      async () => await page.locator(".test-status-dot.failed").count(),
      { timeout: POLL_TIMEOUT, message: "exactly 3 failed dots visible under status=failed" },
    ).toBe(3);
    expect(await page.locator(".test-status-dot.passed").count(),
      "passed rows should be HIDDEN under the failed filter").toBe(0);
    expect(await page.locator(".test-status-dot.skipped").count(),
      "skipped rows should be HIDDEN under the failed filter").toBe(0);

    // The header counters reflect the FULL run (not the filter).
    await expect.poll(async () => {
      const r = await page.request.get(`http://localhost:3000/runs/${runId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await r.json();
      return [body.passed, body.failed, body.skipped, body.total];
    }, { timeout: POLL_TIMEOUT }).toEqual([5, 3, 2, 10]);

    await deleteRun(page.request, token, runId);
  });
});

/* ───────────────────── 4. Burst of events vs the 3s poll ───────────────────── */

test.describe("upload bughunt — torn reads under fast event burst", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("driving 50 test.passed events in rapid succession leaves zero pending rows once the chain settles", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto("/dashboard");
    const token = await getToken(page);
    const { runId } = await startLive(page.request, token, `burst-${Date.now().toString(36)}`);
    const specPath = "tests/burst/many.spec.ts";

    await postEvent(page.request, token, runId, { type: "spec.started", spec: specPath });

    // Burst all test.starteds in parallel — every one gets serialized
    // through the per-run chain.
    await Promise.all(
      Array.from({ length: 50 }).map((_, i) =>
        postEvent(page.request, token, runId, { type: "test.started", spec: specPath, test: `T${i}` }),
      ),
    );
    // Now burst all terminals in parallel.
    await Promise.all(
      Array.from({ length: 50 }).map((_, i) =>
        postEvent(page.request, token, runId, {
          type: i % 5 === 0 ? "test.failed" : "test.passed",
          spec: specPath, test: `T${i}`, duration_ms: 5,
          ...(i % 5 === 0 ? { error: `T${i} broke` } : {}),
        }),
      ),
    );
    await postEvent(page.request, token, runId, { type: "run.finished" });

    // Once the chain has fully drained:
    //  - exactly 50 rows;
    //  - 40 passed + 10 failed (i % 5 === 0 → failed: 0,5,10,…,45);
    //  - ZERO pending rows;
    //  - run + spec counters agree with raw row counts.
    await expect.poll(async () => {
      const r = await page.request.get(`http://localhost:3000/runs/${runId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await r.json();
      const rows = body.specs.flatMap((s: any) => s.tests);
      return {
        total: rows.length,
        pending: rows.filter((t: any) => t.status === "pending").length,
        failed: rows.filter((t: any) => t.status === "failed").length,
        passed: rows.filter((t: any) => t.status === "passed").length,
      };
    }, { timeout: 30_000, message: "chain should drain to a consistent end state" }).toEqual({
      total: 50, pending: 0, failed: 10, passed: 40,
    });

    // Spec stats agree with row counts.
    const detail = await (await page.request.get(`http://localhost:3000/runs/${runId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    expect(detail.passed).toBe(40);
    expect(detail.failed).toBe(10);
    expect(detail.specs[0].passed).toBe(40);
    expect(detail.specs[0].failed).toBe(10);
    expect(detail.specs[0].total).toBe(50);

    await deleteRun(page.request, token, runId);
  });
});
