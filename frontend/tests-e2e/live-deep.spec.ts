import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { ADMIN_USER } from "./fixtures/users";

/**
 * Round-four live coverage — deeper scenarios the earlier rounds don't
 * reach:
 *
 *   1. Live → /runs/upload merge preserves live screenshots. The
 *      end-of-run batch upload deletes-and-reinserts every test row
 *      for each spec; the docs (CLAUDE.md) claim live screenshot
 *      paths are preserved by re-applying them by full_title.
 *      Untested until now.
 *
 *   2. Stats correctness under bulk events. Drive a run with a known
 *      mix of passed / failed / skipped events and assert that the
 *      run-detail's spec.total/passed/failed/skipped + run-level
 *      counts match the actual test rows. recomputeSpecAndRunStats
 *      runs after every event — easy place for a typo to drift.
 *
 *   3. run.finished + /abort fired concurrently for the same run.
 *      The per-run chain serializes them; whichever lands first wins
 *      and the run ends in a single, consistent state. No zombie
 *      pending, no double-emit weirdness, no error response.
 *
 *   4. DELETE /runs/<id> while events are still in the chain. The
 *      delete must not crash, the run must really be gone, and the
 *      backend must keep accepting other runs' events afterwards.
 *
 *   5. /live/:id/snapshot — analogous coverage to the screenshot
 *      endpoint: snapshot lands on the right test row, scoped by
 *      spec.file_path so a same-titled test in a different spec of
 *      the same run does NOT pick it up.
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
    data: { suite, branch: "main", commitSha: "deep" },
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

type TestRow = {
  title: string;
  full_title: string;
  status: string;
  screenshot_paths?: string[];
  snapshot_path?: string | null;
  duration_ms?: number;
  error_message?: string | null;
};
type SpecRow = {
  id: number;
  file_path: string;
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  duration_ms?: number;
  tests: TestRow[];
};
type RunDetail = {
  id?: number;
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  pending?: number;
  duration_ms?: number;
  specs: SpecRow[];
};

async function fetchRunDetail(
  request: APIRequestContext,
  token: string,
  runId: number,
): Promise<RunDetail> {
  const r = await request.get(`http://localhost:3000/runs/${runId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(r.status()).toBe(200);
  return r.json();
}

const MINIMAL_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/* ───────────────────── 1. Live → /runs/upload merge ───────────────────── */

test.describe("live deep — /runs/upload merge preserves live screenshots", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("a live screenshot uploaded mid-run survives the end-of-run upload's tests delete+reinsert", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto("/dashboard");
    const token = await getToken(page);
    // findOrCreateRun matches on (org_id, suite_name, ci_run_id) — all three
    // must equal what the live placeholder was created with, so capture the
    // suite name once and pass it to both /live/start and /runs/upload.
    const suiteName = `merge-${Date.now().toString(36)}`;
    const { runId, ciRunId } = await startLive(page.request, token, suiteName);
    const specPath = "tests/auth/login.spec.ts";
    const fullTitle = "Auth flow > should login successfully";

    // Drive the live half of the run.
    await postEvent(page.request, token, runId, { type: "spec.started", spec: specPath });
    await postEvent(page.request, token, runId, { type: "test.started", spec: specPath, test: fullTitle });

    const ssRes = await page.request.post(`http://localhost:3000/live/${runId}/screenshot`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        screenshot: { name: "live-merge-shot.png", mimeType: "image/png", buffer: MINIMAL_PNG },
        spec: specPath,
        testTitle: fullTitle,
      },
    });
    expect(ssRes.status()).toBe(200);
    const liveKey = ((await ssRes.json()) as { key: string }).key;

    await postEvent(page.request, token, runId, {
      type: "test.passed", spec: specPath, test: fullTitle, duration_ms: 100,
    });
    await postEvent(page.request, token, runId, { type: "run.finished" });

    // Sanity: live key is on the row before upload.
    await expect.poll(async () => {
      const d = await fetchRunDetail(page.request, token, runId);
      const t = d.specs.flatMap((s) => s.tests).find((x) => x.full_title === fullTitle);
      return t?.screenshot_paths ?? [];
    }, { timeout: 15_000, message: "live screenshot key should be present pre-upload" }).toContain(liveKey);

    // Now the reporter (or CI) follows up with the authoritative
    // end-of-run upload — same ci_run_id, same suite/branch/commit so
    // findOrCreateRun merges into the live placeholder rather than
    // creating a new run.
    const uploadPayload = {
      meta: {
        suite_name: suiteName,
        branch: "main",
        commit_sha: "deep",
        ci_run_id: ciRunId,
        started_at: new Date(Date.now() - 60_000).toISOString(),
        finished_at: new Date().toISOString(),
        reporter: "playwright",
      },
      stats: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0, duration_ms: 100 },
      specs: [
        {
          file_path: specPath,
          title: "login.spec.ts",
          stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration_ms: 100 },
          tests: [
            {
              title: "should login successfully",
              full_title: fullTitle,
              status: "passed" as const,
              duration_ms: 100,
              screenshot_paths: [], // batch upload didn't ship any extra screenshots
            },
          ],
        },
      ],
    };

    const upRes = await page.request.post("http://localhost:3000/runs/upload", {
      headers: { Authorization: `Bearer ${token}` },
      multipart: { payload: JSON.stringify(uploadPayload) },
    });
    expect(upRes.status(), "upload should succeed (200 if merged, 201 if new)").toBeLessThan(300);
    const upBody = (await upRes.json()) as { id: number; merged?: boolean };
    expect(upBody.id, "upload should land on the SAME run id as the live placeholder").toBe(runId);
    expect(upBody.merged, "the upload should report merged=true").toBe(true);

    // The /runs/<id> view must show the test still has the live screenshot.
    // The end-of-run upload deleted the live test rows and reinserted them;
    // the contract is that screenshot_paths from the live phase are
    // preserved by full_title and re-applied to the fresh row.
    const merged = await fetchRunDetail(page.request, token, runId);
    const allTests = merged.specs.flatMap((s) => s.tests);
    expect(allTests.length, "exactly one test row after merge — no duplicates").toBe(1);
    const t = allTests[0];
    expect(t.full_title).toBe(fullTitle);
    expect(t.status).toBe("passed");
    expect(
      t.screenshot_paths ?? [],
      "live screenshot key should survive the upload's delete+reinsert",
    ).toContain(liveKey);

    await deleteRun(page.request, token, runId);
  });
});

/* ───────────────────── 2. Stats correctness under bulk events ───────────────────── */

test.describe("live deep — stats stay consistent with row counts under bulk events", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("after a 10-test mix of passed/failed/skipped, run + spec stats exactly match the row counts", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto("/dashboard");
    const token = await getToken(page);
    const { runId } = await startLive(page.request, token, `stats-${Date.now().toString(36)}`);
    const specPath = "tests/edge/stats-mix.spec.ts";

    // Concrete intent: 5 passed, 3 failed, 2 skipped. Drive in a single
    // batched POST so events flow through one IIFE in deterministic
    // order — that's the ordering we assert against.
    const planned: { title: string; outcome: "passed" | "failed" | "skipped" }[] = [
      { title: "passes-1", outcome: "passed" },
      { title: "passes-2", outcome: "passed" },
      { title: "fails-1", outcome: "failed" },
      { title: "passes-3", outcome: "passed" },
      { title: "skipped-1", outcome: "skipped" },
      { title: "fails-2", outcome: "failed" },
      { title: "passes-4", outcome: "passed" },
      { title: "passes-5", outcome: "passed" },
      { title: "fails-3", outcome: "failed" },
      { title: "skipped-2", outcome: "skipped" },
    ];

    await postEvent(page.request, token, runId, { type: "spec.started", spec: specPath });
    for (const p of planned) {
      await postEvent(page.request, token, runId, { type: "test.started", spec: specPath, test: p.title });
    }
    for (const p of planned) {
      const event: Record<string, unknown> =
        p.outcome === "passed"
          ? { type: "test.passed", spec: specPath, test: p.title, duration_ms: 50 }
          : p.outcome === "failed"
          ? { type: "test.failed", spec: specPath, test: p.title, duration_ms: 75, error: `${p.title} failed` }
          : { type: "test.skipped", spec: specPath, test: p.title };
      await postEvent(page.request, token, runId, event);
    }
    await postEvent(page.request, token, runId, { type: "run.finished" });

    // Poll until the per-run chain has fully drained (last event's
    // recomputeSpecAndRunStats committed). The `pending` count drops
    // last because the chain awaits all DB writes before run.finished's
    // SSE emit, so once it's 0 the rest is settled.
    await expect.poll(async () => {
      const d = await fetchRunDetail(page.request, token, runId);
      const rows = d.specs.flatMap((s) => s.tests);
      return rows.filter((t) => t.status === "pending").length;
    }, { timeout: 15_000 }).toBe(0);

    const detail = await fetchRunDetail(page.request, token, runId);
    const rows = detail.specs.flatMap((s) => s.tests);

    // Row-count truth.
    const actualPassed = rows.filter((t) => t.status === "passed").length;
    const actualFailed = rows.filter((t) => t.status === "failed").length;
    const actualSkipped = rows.filter((t) => t.status === "skipped").length;

    expect(actualPassed, "5 passed rows in the DB").toBe(5);
    expect(actualFailed, "3 failed rows in the DB").toBe(3);
    expect(actualSkipped, "2 skipped rows in the DB").toBe(2);
    expect(rows.length, "exactly 10 rows total — no duplicates from per-event recompute").toBe(10);

    // Run stats agree with the row counts.
    expect(detail.passed).toBe(actualPassed);
    expect(detail.failed).toBe(actualFailed);
    expect(detail.skipped).toBe(actualSkipped);
    expect(detail.total).toBe(rows.length);

    // Spec stats agree, too — recompute writes both spec and run.
    expect(detail.specs.length).toBe(1);
    const spec = detail.specs[0];
    expect(spec.passed).toBe(actualPassed);
    expect(spec.failed).toBe(actualFailed);
    expect(spec.skipped).toBe(actualSkipped);
    expect(spec.total).toBe(rows.length);

    await deleteRun(page.request, token, runId);
  });
});

/* ───────────────────── 3. run.finished + /abort race ───────────────────── */

test.describe("live deep — run.finished + /abort fired concurrently", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("racing run.finished and /abort end the run in a single consistent state, no zombies", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);
    const { runId } = await startLive(page.request, token, `race-${Date.now().toString(36)}`);
    const specPath = "tests/edge/race-finish-abort.spec.ts";

    await postEvent(page.request, token, runId, { type: "spec.started", spec: specPath });
    await postEvent(page.request, token, runId, { type: "test.started", spec: specPath, test: "T1" });
    await postEvent(page.request, token, runId, {
      type: "test.passed", spec: specPath, test: "T1", duration_ms: 50,
    });
    await postEvent(page.request, token, runId, { type: "test.started", spec: specPath, test: "T2-stays-pending" });

    // Fire the closing pair concurrently.
    const [finishedRes, abortRes] = await Promise.all([
      page.request.post(`http://localhost:3000/live/${runId}/events`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        data: { type: "run.finished" },
      }),
      page.request.post(`http://localhost:3000/live/${runId}/abort`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        data: { reason: "racing abort" },
      }),
    ]);
    expect(finishedRes.status(), "run.finished should accept regardless of order").toBe(200);
    expect(abortRes.status(), "abort should accept regardless of order").toBeLessThan(400);

    // End state must be deterministic: T1 stays passed (terminal events
    // never get rewound), T2's pending row is either still pending
    // (if run.finished landed first and abort transitioned nothing
    // because there are no longer any pending rows... but T2 IS still
    // pending at the moment run.finished emits) OR has been
    // transitioned to skipped (if abort landed first). Whatever order
    // wins, T2 must NOT remain in the user-visible "running" /
    // "in-progress" state forever, and there must NOT be more than one
    // row per (spec, title).
    const detail = await fetchRunDetail(page.request, token, runId);
    const rows = detail.specs.flatMap((s) => s.tests);
    expect(rows.length, "exactly two test rows — no duplicates from the race").toBe(2);
    const t1 = rows.find((r) => r.title === "T1");
    const t2 = rows.find((r) => r.title === "T2-stays-pending");
    expect(t1?.status, "the already-passed test stays passed").toBe("passed");
    expect(t2, "T2 row should exist").toBeTruthy();
    // The acceptable end states for T2: 'pending' (if run.finished
    // beat abort and abort then transitioned nothing because...
    // actually abort always transitions whatever pending is there at
    // the time it runs, so) OR 'skipped'. But if it's still pending,
    // the run is misleading — the abort should have caught it. Assert
    // the *intent*: T2 is no longer pending after both endpoints
    // finished serving.
    expect(
      ["passed", "failed", "skipped"].includes(t2!.status),
      `T2 must be in a terminal state, got '${t2!.status}'`,
    ).toBe(true);

    await deleteRun(page.request, token, runId);
  });
});

/* ───────────────────── 4. DELETE during in-flight chain ───────────────────── */

test.describe("live deep — DELETE /runs/<id> with chain work in flight", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("deleting a run while events are still queued does not crash the backend; another run continues unaffected", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);
    const a = await startLive(page.request, token, `del-A-${Date.now().toString(36)}`);
    const b = await startLive(page.request, token, `del-B-${Date.now().toString(36)}`);
    const spec = "tests/edge/del-during-chain.spec.ts";

    // Queue a stream of events for run A, then immediately fire the
    // delete. The chain still has work pending; the delete should not
    // collide with it (foreign keys cascade tests + specs + live_events
    // by run_id) and should not panic the backend.
    await Promise.all(
      Array.from({ length: 8 }).map((_, i) =>
        postEvent(page.request, token, a.runId, {
          type: "test.started", spec, test: `T${i}`,
        }),
      ),
    );

    const delRes = await page.request.delete(`http://localhost:3000/runs/${a.runId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delRes.status(), "delete should succeed even with chain work pending").toBeLessThan(300);

    // Run A's detail is now 404. Some chain entries may still have
    // tried to insert against the deleted spec/run; foreign-key cascade
    // (on delete cascade) handles the cleanup, and any errors should
    // be swallowed by the chain's catch — not bubble to the response.
    await expect.poll(async () => {
      const r = await page.request.get(`http://localhost:3000/runs/${a.runId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return r.status();
    }, { timeout: 5_000 }).toBe(404);

    // Run B is unaffected: events flow, rows materialise, run.finished
    // closes it cleanly. This is the load-bearing assertion — a crash
    // from run A's deletion would kill the express process and break
    // run B's POSTs.
    await postEvent(page.request, token, b.runId, { type: "spec.started", spec });
    await postEvent(page.request, token, b.runId, { type: "test.started", spec, test: "B-survives" });
    await postEvent(page.request, token, b.runId, {
      type: "test.passed", spec, test: "B-survives", duration_ms: 25,
    });
    await postEvent(page.request, token, b.runId, { type: "run.finished" });

    await expect.poll(async () => {
      const d = await fetchRunDetail(page.request, token, b.runId);
      return d.specs.flatMap((s) => s.tests).map((t) => `${t.title}:${t.status}`);
    }, { timeout: 15_000 }).toEqual(["B-survives:passed"]);

    await deleteRun(page.request, token, b.runId);
  });
});

/* ───────────────────── 5. Snapshot endpoint ───────────────────── */

test.describe("live deep — snapshot endpoint cross-spec scoping", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("/snapshot attaches to the matching test row and does NOT leak to a same-named test in a different spec", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);
    const { runId } = await startLive(page.request, token, `snap-${Date.now().toString(36)}`);
    const specA = "tests/checkout/payment.spec.ts";
    const specB = "tests/admin/payment.spec.ts";
    const sharedTitle = "should accept a valid card";

    await postEvent(page.request, token, runId, { type: "spec.started", spec: specA });
    await postEvent(page.request, token, runId, { type: "spec.started", spec: specB });
    await postEvent(page.request, token, runId, { type: "test.started", spec: specA, test: sharedTitle });
    await postEvent(page.request, token, runId, { type: "test.started", spec: specB, test: sharedTitle });

    // The snapshot endpoint expects a JSON-gzipped DOM bundle; for the
    // contract we're testing, the file contents don't matter — the
    // backend stores whatever buffer it gets at the computed key.
    const snapshotRes = await page.request.post(`http://localhost:3000/live/${runId}/snapshot`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        snapshot: {
          name: "snap.json.gz",
          mimeType: "application/gzip",
          buffer: Buffer.from('{"frames":[]}', "utf8"),
        },
        spec: specA,
        testTitle: sharedTitle,
      },
    });
    expect(snapshotRes.status(), "snapshot upload should accept").toBe(200);
    const key = ((await snapshotRes.json()) as { key: string }).key;
    expect(key).toContain(`runs/${runId}/snapshots/`);

    await postEvent(page.request, token, runId, {
      type: "test.passed", spec: specA, test: sharedTitle, duration_ms: 80,
    });
    await postEvent(page.request, token, runId, {
      type: "test.passed", spec: specB, test: sharedTitle, duration_ms: 80,
    });
    await postEvent(page.request, token, runId, { type: "run.finished" });

    // specA's row gets the snapshot_path; specB's same-titled row stays null.
    await expect.poll(async () => {
      const d = await fetchRunDetail(page.request, token, runId);
      const sa = d.specs.find((s) => s.file_path === specA);
      const t = sa?.tests.find((x) => x.title === sharedTitle);
      return t?.snapshot_path ?? null;
    }, { timeout: 15_000, message: "spec A's row should gain the snapshot_path" }).toBe(key);

    const detail = await fetchRunDetail(page.request, token, runId);
    const bSpec = detail.specs.find((s) => s.file_path === specB);
    const bRow = bSpec?.tests.find((x) => x.title === sharedTitle);
    expect(bRow, "spec B's row should exist").toBeTruthy();
    expect(
      bRow?.snapshot_path ?? null,
      "spec B's same-titled row must NOT pick up spec A's snapshot",
    ).toBeNull();

    await deleteRun(page.request, token, runId);
  });
});
