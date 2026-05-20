import { expect, test, type APIRequestContext, type Page } from "../fixtures/test";

import { ADMIN_USER, DEMO_USER } from "../fixtures/users";

/**
 * Round-three live coverage — edge cases that the lifecycle, parallel,
 * and isolation suites don't reach:
 *
 *   1. Out-of-order events: a reporter retry or dropped batch can land
 *      `test.passed` before `test.started`. The end state must be ONE
 *      consistent terminal row, not a passed row + a zombie pending.
 *
 *   2. Concurrent screenshot uploads against the same test row: five
 *      simultaneous POSTs each with a distinct file. `array_append` plus
 *      the dedupe guard in /screenshot must produce exactly five distinct
 *      keys with no missing or duplicated entries.
 *
 *   3. Cross-spec same-title scoping: a run with two specs both
 *      containing a test called "login". A screenshot uploaded for
 *      (specA, "login") must NOT attach to specB's row even though the
 *      title matches.
 *
 *   4. `/live/active` cross-org listing — admin in acme starts a run;
 *      viewer in demo-team's GET /live/active must not include it.
 *
 *   5. Special-char titles (`%`, `_`, `\`, emoji, quote): events flow,
 *      screenshot LIKE-pattern matching, and run-detail fetch all
 *      survive the round-trip without corruption or wildcard widening.
 */

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

async function startLive(
  request: APIRequestContext,
  token: string,
  suite: string,
): Promise<number> {
  const res = await request.post("http://localhost:3000/live/start", {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: { suite, branch: "main", commitSha: "edge" },
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

async function deleteRun(request: APIRequestContext, token: string, runId: number): Promise<void> {
  await request.delete(`http://localhost:3000/runs/${runId}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

type TestRow = { title: string; full_title: string; status: string; screenshot_paths?: string[]; spec_id?: number };
type SpecRow = { id: number; file_path: string; tests: TestRow[] };

async function fetchRunDetail(
  request: APIRequestContext,
  token: string,
  runId: number,
): Promise<{ specs: SpecRow[] }> {
  const r = await request.get(`http://localhost:3000/runs/${runId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(r.status()).toBe(200);
  return r.json();
}

// Minimal valid 1×1 PNG — just enough for the multipart endpoint to
// accept and persist. Distinct filename per upload makes screenshot_paths
// uniqueness easy to assert.
const MINIMAL_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

async function uploadScreenshot(
  request: APIRequestContext,
  token: string,
  runId: number,
  spec: string,
  testTitle: string,
  filename: string,
): Promise<{ status: number; key?: string }> {
  const res = await request.post(`http://localhost:3000/live/${runId}/screenshot`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      screenshot: { name: filename, mimeType: "image/png", buffer: MINIMAL_PNG },
      spec,
      testTitle,
    },
  });
  const status = res.status();
  if (status !== 200) return { status };
  return { status, key: ((await res.json()) as { key: string }).key };
}

/* ───────────────────── 1. Out-of-order events ───────────────────── */

test.describe("live edge — events arriving out of order", () => {

  test("test.passed arriving before test.started for the same title still resolves to ONE consistent row", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);
    const runId = await startLive(page.request, token, `ooo-${Date.now().toString(36)}`);
    const spec = "tests/edge/ooo.spec.ts";
    const title = "should resolve out-of-order events";

    // Reverse order: terminal first, then the start event.
    await postEvent(page.request, token, runId, { type: "spec.started", spec });
    await postEvent(page.request, token, runId, {
      type: "test.passed", spec, test: title, duration_ms: 250,
    });
    // …reporter retry / dropped batch / clock-skew lands the missing
    // test.started afterwards.
    await postEvent(page.request, token, runId, { type: "test.started", spec, test: title });

    await postEvent(page.request, token, runId, { type: "run.finished" });

    // Final state: exactly one row with title=title. Status MAY be either
    // 'passed' (terminal landed first; the late test.started's
    // INSERT-pending was a no-op via the partial unique index) or
    // 'pending' (the late test.started clobbered with a stray pending
    // row). Either case must NOT leave the run with a duplicate row.
    const detail = await fetchRunDetail(page.request, token, runId);
    const matches = detail.specs.flatMap((s) => s.tests).filter((t) => t.title === title);
    expect(matches.length, "out-of-order events should not produce duplicate rows").toBe(1);
    expect(matches[0].status, "the surviving row should not be pending after run.finished").not.toBe("pending");

    await deleteRun(page.request, token, runId);
  });
});

/* ───────────────────── 2. Concurrent screenshot uploads ───────────────────── */

test.describe("live edge — concurrent screenshot uploads", () => {

  test("five simultaneous /screenshot POSTs against the same test land as five distinct keys, no duplicates, no missing", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);
    const runId = await startLive(page.request, token, `ss-conc-${Date.now().toString(36)}`);
    const spec = "tests/edge/concurrent-screenshots.spec.ts";
    const title = "should accept many screenshots in parallel";

    await postEvent(page.request, token, runId, { type: "spec.started", spec });
    await postEvent(page.request, token, runId, { type: "test.started", spec, test: title });

    // Five distinct filenames so the storage keys are unique and so we
    // can assert exactly five entries land in screenshot_paths.
    const filenames = ["a.png", "b.png", "c.png", "d.png", "e.png"];
    const results = await Promise.all(
      filenames.map((name) => uploadScreenshot(page.request, token, runId, spec, title, name)),
    );
    for (const r of results) {
      expect(r.status, "every concurrent screenshot upload should succeed").toBe(200);
    }
    const expectedKeys = new Set(results.map((r) => r.key));
    expect(expectedKeys.size, "each upload should produce a distinct storage key").toBe(filenames.length);

    await postEvent(page.request, token, runId, {
      type: "test.passed", spec, test: title, duration_ms: 50,
    });

    await expect.poll(async () => {
      const detail = await fetchRunDetail(page.request, token, runId);
      const t = detail.specs.flatMap((s) => s.tests).find((x) => x.title === title);
      const paths = new Set(t?.screenshot_paths ?? []);
      return paths.size;
    }, {
      timeout: 15_000,
      message: "all five distinct screenshot paths should be appended (array_append + dedupe is concurrency-safe)",
    }).toBe(filenames.length);

    // Belt-and-braces: the actual paths in the DB are exactly the ones
    // returned by the upload responses (no surprise additions).
    const finalDetail = await fetchRunDetail(page.request, token, runId);
    const t = finalDetail.specs.flatMap((s) => s.tests).find((x) => x.title === title);
    expect(new Set(t?.screenshot_paths ?? [])).toEqual(expectedKeys);

    await postEvent(page.request, token, runId, { type: "run.finished" });
    await deleteRun(page.request, token, runId);
  });
});

/* ───────────────────── 3. Cross-spec same-title scoping ───────────────────── */

test.describe("live edge — cross-spec same-title scoping", () => {

  test("two specs in the same run with a test called 'login' — a screenshot for spec A does NOT attach to spec B's row", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);
    const runId = await startLive(page.request, token, `xspec-${Date.now().toString(36)}`);
    const specA = "tests/auth/login.spec.ts";
    const specB = "tests/billing/login.spec.ts"; // different file, same leaf "login.spec.ts"
    const title = "login";

    await postEvent(page.request, token, runId, { type: "spec.started", spec: specA });
    await postEvent(page.request, token, runId, { type: "spec.started", spec: specB });
    await postEvent(page.request, token, runId, { type: "test.started", spec: specA, test: title });
    await postEvent(page.request, token, runId, { type: "test.started", spec: specB, test: title });

    // Upload one screenshot tagged for specA.
    const upload = await uploadScreenshot(page.request, token, runId, specA, title, "spec-a-shot.png");
    expect(upload.status).toBe(200);

    // The matching test row in specA gets the screenshot; specB's same-
    // titled row stays empty. Locating each by spec.file_path so we
    // don't mix them up.
    await expect.poll(async () => {
      const d = await fetchRunDetail(page.request, token, runId);
      const aSpec = d.specs.find((s) => s.file_path === specA);
      const aRow = aSpec?.tests.find((t) => t.title === title);
      return aRow?.screenshot_paths?.length ?? 0;
    }, { timeout: 15_000, message: "spec A's row should gain the screenshot" }).toBeGreaterThanOrEqual(1);

    const detail = await fetchRunDetail(page.request, token, runId);
    const bSpec = detail.specs.find((s) => s.file_path === specB);
    const bRow = bSpec?.tests.find((t) => t.title === title);
    expect(bRow, "spec B should still have its 'login' row").toBeTruthy();
    expect(
      bRow?.screenshot_paths ?? [],
      "spec B's 'login' row must NOT pick up spec A's screenshot",
    ).toEqual([]);

    await postEvent(page.request, token, runId, {
      type: "test.passed", spec: specA, test: title, duration_ms: 100,
    });
    await postEvent(page.request, token, runId, {
      type: "test.passed", spec: specB, test: title, duration_ms: 100,
    });
    await postEvent(page.request, token, runId, { type: "run.finished" });
    await deleteRun(page.request, token, runId);
  });
});

/* ───────────────────── 4. /live/active cross-org listing ───────────────────── */

test.describe("live edge — /live/active cross-org isolation", () => {
  test("acme's active runs are invisible to demo-team's GET /live/active", async ({ browser }) => {
    test.setTimeout(45_000);
    const acmeCtx = await browser.newContext({ storageState: ADMIN_USER.storageStatePath });
    const demoCtx = await browser.newContext({ storageState: DEMO_USER.storageStatePath });

    try {
      const acmePage = await acmeCtx.newPage();
      const demoPage = await demoCtx.newPage();
      await Promise.all([acmePage.goto("/dashboard"), demoPage.goto("/dashboard")]);
      const acmeToken = await getToken(acmePage);
      const demoToken = await getToken(demoPage);

      // Acme starts a run that stays "active" (no run.finished).
      const acmeRun = await startLive(acmePage.request, acmeToken, `act-${Date.now().toString(36)}`);

      // Acme sees its own run in /live/active.
      await expect.poll(async () => {
        const r = await acmePage.request.get("http://localhost:3000/live/active", {
          headers: { Authorization: `Bearer ${acmeToken}` },
        });
        expect(r.status()).toBe(200);
        const ids = ((await r.json()) as { runs: number[] }).runs;
        return ids.includes(acmeRun);
      }, { timeout: 5_000 }).toBe(true);

      // Demo-team's /live/active does NOT include acme's run id.
      const demoActive = await demoPage.request.get("http://localhost:3000/live/active", {
        headers: { Authorization: `Bearer ${demoToken}` },
      });
      expect(demoActive.status()).toBe(200);
      const demoIds = ((await demoActive.json()) as { runs: number[] }).runs;
      expect(demoIds, "demo-team must not see acme's active run id").not.toContain(acmeRun);

      // Cleanup.
      await postEvent(acmePage.request, acmeToken, acmeRun, { type: "run.finished" });
      await deleteRun(acmePage.request, acmeToken, acmeRun);
    } finally {
      await acmeCtx.close();
      await demoCtx.close();
    }
  });
});

/* ───────────────────── 5. Special-char titles round-trip ───────────────────── */

test.describe("live edge — special-character test titles", () => {

  test("titles containing %, _, \\, quotes, and emoji survive event flow + screenshot LIKE matching without wildcard widening", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);
    const runId = await startLive(page.request, token, `chars-${Date.now().toString(36)}`);
    const spec = "tests/edge/special-chars.spec.ts";

    // The title with `%` and `_` is the dangerous one — those are LIKE
    // wildcards. The screenshot endpoint's UPDATE uses
    // `tests.full_title LIKE '%' || $4 ESCAPE '\\'` so the escapes must
    // be honoured. Other titles are 'sibling' rows that must NOT pick
    // up the screenshot when the wildcard is widened.
    const targetTitle = "should match 50% of cases with _exact_ name \\test\\ 🧪";
    const sibling1 = "should match 50ABC of cases with _exact_ name -test- 🧪";
    const sibling2 = "totally different title with no overlap";

    await postEvent(page.request, token, runId, { type: "spec.started", spec });
    await postEvent(page.request, token, runId, { type: "test.started", spec, test: targetTitle });
    await postEvent(page.request, token, runId, { type: "test.started", spec, test: sibling1 });
    await postEvent(page.request, token, runId, { type: "test.started", spec, test: sibling2 });

    // Upload screenshot tagged for the dangerous title. If LIKE escaping
    // is broken, sibling1 (which would match the unescaped pattern via
    // the % and _ wildcards) would also get the screenshot.
    const up = await uploadScreenshot(page.request, token, runId, spec, targetTitle, "special.png");
    expect(up.status).toBe(200);

    await postEvent(page.request, token, runId, {
      type: "test.passed", spec, test: targetTitle, duration_ms: 10,
    });
    await postEvent(page.request, token, runId, {
      type: "test.passed", spec, test: sibling1, duration_ms: 10,
    });
    await postEvent(page.request, token, runId, {
      type: "test.passed", spec, test: sibling2, duration_ms: 10,
    });
    await postEvent(page.request, token, runId, { type: "run.finished" });

    const detail = await fetchRunDetail(page.request, token, runId);
    const tests = detail.specs.flatMap((s) => s.tests);

    // All three rows survived the round-trip with intact titles.
    const titles = tests.map((t) => t.title).sort();
    expect(titles).toEqual([targetTitle, sibling1, sibling2].sort());

    const target = tests.find((t) => t.title === targetTitle);
    expect(
      target?.screenshot_paths?.length ?? 0,
      "the target title's row should have the screenshot",
    ).toBeGreaterThanOrEqual(1);

    const s1 = tests.find((t) => t.title === sibling1);
    const s2 = tests.find((t) => t.title === sibling2);
    expect(
      s1?.screenshot_paths ?? [],
      "sibling1 must NOT pick up the screenshot via LIKE wildcard widening (% / _ escaping check)",
    ).toEqual([]);
    expect(
      s2?.screenshot_paths ?? [],
      "sibling2 must not have the screenshot",
    ).toEqual([]);

    await deleteRun(page.request, token, runId);
  });
});
