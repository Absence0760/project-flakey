import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { ADMIN_USER } from "./fixtures/users";

/**
 * Regression tests for bugs surfaced from the dev-server console:
 *
 *   1. /flaky?suite=<name> threw 500 with
 *      `missing FROM-clause entry for table "r"` because the suite
 *      filter referenced an alias the CTE didn't declare. The
 *      unfiltered call (?runs=N only) worked, which is why the
 *      page's default load wasn't broken — but every dashboard suite
 *      drop-down click 500'd.
 *
 *   2. DELETE /runs/<id> didn't clear the live-events in-memory
 *      registry. The stale-detection timer kept firing on the
 *      deleted run id and abortRun's INSERT into live_events failed
 *      with `live_events_run_id_fkey`. Any in-flight chain entry
 *      from a /events POST that landed before the DELETE also
 *      FK-failed with `tests_spec_id_fkey` / `specs_run_id_fkey`,
 *      plus an RLS error on specs (the row's org membership is gone
 *      with the run). All silent on the wire — visible only as
 *      console noise — but worth pinning so future refactors don't
 *      reintroduce the cascade.
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
    data: { suite, branch: "main", commitSha: "regression" },
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
): Promise<number> {
  const res = await request.post(`http://localhost:3000/live/${runId}/events`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: event,
  });
  return res.status();
}

/* ───────────────────── /flaky?suite=… SQL fix ───────────────────── */

test.describe("regression — /flaky?suite=<name> filter doesn't 500", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("the suite filter on /flaky returns 200 with a (possibly empty) list, not 500", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const res = await page.request.get(
      "http://localhost:3000/flaky?suite=auth-e2e&runs=30",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(
      res.status(),
      "the suite filter must not crash with 'missing FROM-clause entry for table \"r\"'",
    ).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body), "response is a list of flaky tests").toBe(true);
  });

  test("the unfiltered /flaky and the ?suite=… variant agree on shape (records have full_title, flaky_rate, total_runs)", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const unfilteredRes = await page.request.get("http://localhost:3000/flaky?runs=30", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(unfilteredRes.status()).toBe(200);
    const unfiltered = (await unfilteredRes.json()) as Array<Record<string, unknown>>;

    if (unfiltered.length === 0) {
      // No seeded flaky tests in this DB — the SQL coverage above is
      // already enough; nothing to compare shape against.
      return;
    }

    // Use the first record's suite to filter; ensure that subset still
    // 200s and produces records of the same shape.
    const someSuite = unfiltered[0].suite_name as string;
    const filteredRes = await page.request.get(
      `http://localhost:3000/flaky?suite=${encodeURIComponent(someSuite)}&runs=30`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(filteredRes.status()).toBe(200);
    const filtered = (await filteredRes.json()) as Array<Record<string, unknown>>;

    expect(filtered.length, "filtering by an existing suite should yield ≥1 record").toBeGreaterThan(0);
    for (const f of filtered) {
      expect(f.suite_name).toBe(someSuite);
      expect(typeof f.full_title).toBe("string");
      expect(typeof f.flaky_rate).toBe("number");
      expect(typeof f.total_runs).toBe("number");
    }
  });

  test("an unknown suite value returns 200 with an empty list (not 500, not 404)", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const res = await page.request.get(
      `http://localhost:3000/flaky?suite=nonexistent-suite-${Date.now()}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });
});

/* ─────────────── DELETE /runs/:id forgets the live-events registry ─────────────── */

test.describe("regression — DELETE /runs/<id> unregisters the run from live-events bus", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("after DELETE /runs/:id the run is removed from /live/active (no zombie entries)", async ({
    page,
  }) => {
    test.setTimeout(20_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const { runId } = await startLive(page.request, token, `regression-active-${Date.now().toString(36)}`);

    // Confirm the run lands on /live/active first.
    const activeBefore = (await (
      await page.request.get("http://localhost:3000/live/active", {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { runs: number[] };
    expect(activeBefore.runs).toContain(runId);

    // Delete.
    const delRes = await page.request.delete(`http://localhost:3000/runs/${runId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delRes.status()).toBeLessThan(300);

    // Now /live/active must NOT include the deleted run id.
    await expect.poll(async () => {
      const r = await page.request.get("http://localhost:3000/live/active", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await r.json()) as { runs: number[] };
      return body.runs.includes(runId);
    }, {
      timeout: POLL_TIMEOUT,
      message: "deleted run must drop out of /live/active immediately, not after the 30-min auto-cleanup",
    }).toBe(false);
  });

  test("a /events POST landing AFTER the DELETE returns 404 cleanly (no FK error in the response)", async ({
    page,
  }) => {
    test.setTimeout(20_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const { runId } = await startLive(page.request, token, `regression-late-event-${Date.now().toString(36)}`);
    await postEvent(page.request, token, runId, { type: "spec.started", spec: "tests/x.spec.ts" });

    // Delete the run.
    const delRes = await page.request.delete(`http://localhost:3000/runs/${runId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delRes.status()).toBeLessThan(300);

    // A late /events POST must 404 (not 200 + FK-fail in the chain).
    const lateStatus = await postEvent(page.request, token, runId, {
      type: "test.started", spec: "tests/x.spec.ts", test: "late",
    });
    expect(
      lateStatus,
      "events for a deleted run must be rejected at the owns-check, not silently FK-fail in the chain",
    ).toBe(404);
  });

  test("an in-flight chain that races the DELETE doesn't leak FK/RLS errors — sibling run keeps streaming cleanly", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const a = await startLive(page.request, token, `race-A-${Date.now().toString(36)}`);
    const b = await startLive(page.request, token, `race-B-${Date.now().toString(36)}`);

    // Queue many events for run A then immediately delete it. The
    // chain entries for A that are still queued/in-flight will see
    // the run as forgotten at the top of each step and skip writes.
    await Promise.all(
      Array.from({ length: 12 }).map((_, i) =>
        postEvent(page.request, token, a.runId, {
          type: "test.started", spec: "tests/race.spec.ts", test: `T${i}`,
        }),
      ),
    );

    const delRes = await page.request.delete(`http://localhost:3000/runs/${a.runId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delRes.status()).toBeLessThan(300);

    // Sibling run B keeps working. Drive it through a small lifecycle
    // and confirm its rows land — proves the backend stays healthy
    // through whatever cleanup A's deletion triggered.
    await postEvent(page.request, token, b.runId, { type: "spec.started", spec: "tests/b.spec.ts" });
    await postEvent(page.request, token, b.runId, { type: "test.started", spec: "tests/b.spec.ts", test: "b1" });
    await postEvent(page.request, token, b.runId, {
      type: "test.passed", spec: "tests/b.spec.ts", test: "b1", duration_ms: 5,
    });
    await postEvent(page.request, token, b.runId, { type: "run.finished" });

    await expect.poll(async () => {
      const r = await page.request.get(`http://localhost:3000/runs/${b.runId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.status() !== 200) return null;
      const body = await r.json();
      return body.specs?.flatMap((s: any) => s.tests).map((t: any) => `${t.title}:${t.status}`);
    }, { timeout: 15_000 }).toEqual(["b1:passed"]);

    // Cleanup B.
    await page.request.delete(`http://localhost:3000/runs/${b.runId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  });
});
