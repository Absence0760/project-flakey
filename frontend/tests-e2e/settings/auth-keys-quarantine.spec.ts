import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { ADMIN_USER, DEMO_USER } from "../fixtures/users";

/**
 * E2E coverage for three high-risk surfaces with no test today:
 *
 *   1. API keys — create / list / use / revoke. Every CI customer
 *      depends on these working; a regression silently breaks every
 *      integration.
 *
 *   2. Quarantine — add / list / check / remove a test. Quarantined
 *      tests are how customers manage flaky-test triage; the API
 *      shape and tenancy scoping are critical.
 *
 *   3. Test prediction — POST /predict/tests with changed file paths
 *      returns a ranked list. Used by the MCP `predict_tests` tool
 *      and the CI prediction endpoint; format regressions are silent.
 */

const POLL_TIMEOUT = 10_000;

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

/* ───────────────────── 1. API key CRUD + auth ───────────────────── */

test.describe("auth — API key full lifecycle (create, use, revoke)", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("create → list → use to authenticate /runs/upload → revoke → confirm revoked key is rejected", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    // ── Create an API key.
    const label = `e2e-key-${Date.now().toString(36)}`;
    const createRes = await page.request.post("http://localhost:3000/auth/api-keys", {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { label },
    });
    expect(createRes.status()).toBe(201);
    const created = (await createRes.json()) as { key: string; prefix: string; label: string };
    expect(created.key, "create response must include the raw key (only time it's exposed)").toMatch(/^fk_[a-f0-9]{48}$/);
    expect(created.label).toBe(label);
    expect(created.prefix).toBe(created.key.slice(0, 8));

    // ── List should include the new key (without the secret — only the prefix).
    const listRes = await page.request.get("http://localhost:3000/auth/api-keys", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const keys = (await listRes.json()) as { id: number; key_prefix: string; label: string }[];
    const ours = keys.find((k) => k.label === label);
    expect(ours, "the new key must appear in the list").toBeTruthy();
    expect((ours as any).key, "list response must NEVER include the raw secret").toBeUndefined();
    expect(ours!.key_prefix).toBe(created.prefix);
    const keyId = ours!.id;

    // ── Use the API key to upload a run (the CI integration path).
    const ciRunId = `apikey-test-${Date.now().toString(36)}`;
    const uploadPayload = {
      meta: {
        suite_name: "api-key-e2e",
        branch: "main",
        commit_sha: "deadbeef",
        ci_run_id: ciRunId,
        started_at: new Date(Date.now() - 30_000).toISOString(),
        finished_at: new Date().toISOString(),
        reporter: "playwright",
      },
      stats: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0, duration_ms: 50 },
      specs: [{
        file_path: "tests/api-key.spec.ts",
        title: "api-key.spec.ts",
        stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration_ms: 50 },
        tests: [{
          title: "uploads via API key",
          full_title: "uploads via API key",
          status: "passed" as const,
          duration_ms: 50,
          screenshot_paths: [],
        }],
      }],
    };

    const uploadRes = await page.request.post("http://localhost:3000/runs/upload", {
      headers: { Authorization: `Bearer ${created.key}` },
      multipart: { payload: JSON.stringify(uploadPayload) },
    });
    expect(uploadRes.status(), "API key must authenticate /runs/upload like a JWT does").toBeLessThan(300);
    const uploaded = (await uploadRes.json()) as { id: number };
    expect(uploaded.id).toBeGreaterThan(0);

    // ── Last-used-at should now be populated. The auth middleware
    // updates it via a fire-and-forget UPDATE; poll until it lands.
    await expect.poll(async () => {
      const r = await page.request.get("http://localhost:3000/auth/api-keys", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const ks = (await r.json()) as { id: number; last_used_at: string | null }[];
      const k = ks.find((x) => x.id === keyId);
      return k?.last_used_at ?? null;
    }, {
      timeout: 5_000,
      message: "API-key use should bump last_used_at (fire-and-forget UPDATE — give it a moment)",
    }).not.toBeNull();

    // ── Revoke.
    const delRes = await page.request.delete(`http://localhost:3000/auth/api-keys/${keyId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delRes.status()).toBe(200);

    // ── Revoked key is rejected on subsequent uploads.
    const replayRes = await page.request.post("http://localhost:3000/runs/upload", {
      headers: { Authorization: `Bearer ${created.key}` },
      multipart: { payload: JSON.stringify({ ...uploadPayload, meta: { ...uploadPayload.meta, ci_run_id: `${ciRunId}-2` } }) },
    });
    expect(
      replayRes.status(),
      "a revoked API key must be rejected (not 2xx)",
    ).toBeGreaterThanOrEqual(400);

    // Cleanup the run we created.
    await page.request.delete(`http://localhost:3000/runs/${uploaded.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  test("a key created in acme cannot upload to demo-team's org and vice versa", async ({ browser }) => {
    test.setTimeout(45_000);
    const acmeCtx = await browser.newContext({ storageState: ADMIN_USER.storageStatePath });
    const demoCtx = await browser.newContext({ storageState: DEMO_USER.storageStatePath });

    try {
      const acmePage = await acmeCtx.newPage();
      const demoPage = await demoCtx.newPage();
      await Promise.all([acmePage.goto("/dashboard"), demoPage.goto("/dashboard")]);

      const acmeJwt = await getToken(acmePage);
      const demoJwt = await getToken(demoPage);

      // Acme creates a key.
      const acmeKeyRes = await acmePage.request.post("http://localhost:3000/auth/api-keys", {
        headers: { Authorization: `Bearer ${acmeJwt}`, "Content-Type": "application/json" },
        data: { label: "acme-only" },
      });
      const acmeKey = ((await acmeKeyRes.json()) as { key: string; prefix: string }).key;
      const acmeKeyId = ((await (
        await acmePage.request.get("http://localhost:3000/auth/api-keys", {
          headers: { Authorization: `Bearer ${acmeJwt}` },
        })
      ).json()) as { id: number; label: string }[]).find((k) => k.label === "acme-only")!.id;

      // Demo's API-key list does NOT include acme's key (RLS scoping).
      const demoListRes = await demoPage.request.get("http://localhost:3000/auth/api-keys", {
        headers: { Authorization: `Bearer ${demoJwt}` },
      });
      const demoKeys = (await demoListRes.json()) as { label: string }[];
      expect(demoKeys.find((k) => k.label === "acme-only"), "RLS must keep acme's keys invisible to demo").toBeUndefined();

      // The acme key uploads under acme's org regardless of who calls
      // /runs/upload — the key, not the caller, determines the org.
      // To verify this is enforced, list runs as demo and confirm the
      // acme upload didn't leak.
      const ciRunId = `acme-only-${Date.now().toString(36)}`;
      const upRes = await acmePage.request.post("http://localhost:3000/runs/upload", {
        headers: { Authorization: `Bearer ${acmeKey}` },
        multipart: {
          payload: JSON.stringify({
            meta: {
              suite_name: "tenancy-test",
              branch: "main", commit_sha: "x", ci_run_id: ciRunId,
              started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
              reporter: "playwright",
            },
            stats: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0, duration_ms: 1 },
            specs: [{
              file_path: "tenancy.spec.ts", title: "tenancy.spec.ts",
              stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration_ms: 1 },
              tests: [{
                title: "tenancy", full_title: "tenancy",
                status: "passed" as const, duration_ms: 1, screenshot_paths: [],
              }],
            }],
          }),
        },
      });
      const acmeRunId = ((await upRes.json()) as { id: number }).id;

      // From demo's session, GET /runs/<acmeRunId> must 404.
      const demoSeesAcmeRun = await demoPage.request.get(`http://localhost:3000/runs/${acmeRunId}`, {
        headers: { Authorization: `Bearer ${demoJwt}` },
      });
      expect(demoSeesAcmeRun.status(), "demo cannot see acme's run created via acme-only API key").toBe(404);

      // Cleanup.
      await acmePage.request.delete(`http://localhost:3000/runs/${acmeRunId}`, {
        headers: { Authorization: `Bearer ${acmeJwt}` },
      });
      await acmePage.request.delete(`http://localhost:3000/auth/api-keys/${acmeKeyId}`, {
        headers: { Authorization: `Bearer ${acmeJwt}` },
      });
    } finally {
      await acmeCtx.close();
      await demoCtx.close();
    }
  });
});

/* ───────────────────── 2. Quarantine ───────────────────── */

test.describe("quarantine — add / check / list / remove", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("adding a test to quarantine: it appears in list, check returns true, remove flips it back", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const fullTitle = `quarantine-e2e ${Date.now()}`;
    const suiteName = "qe2e-suite";
    const filePath = "tests/quarantine.spec.ts";
    const reason = "intermittently times out on slow runners";

    // ── Add.
    const addRes = await page.request.post("http://localhost:3000/quarantine", {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { fullTitle, filePath, suiteName, reason },
    });
    expect(addRes.status()).toBe(201);
    const added = (await addRes.json()) as { id: number; quarantined: true };
    expect(added.quarantined).toBe(true);

    // ── /quarantine/check?suite=… returns an array of quarantined
    // tests for that suite (the reporter consults this list to know
    // which test rows to skip). Confirm the new entry is in there.
    const checkRes = await page.request.get(
      `http://localhost:3000/quarantine/check?suite=${encodeURIComponent(suiteName)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(checkRes.status()).toBe(200);
    const checkBody = (await checkRes.json()) as { quarantined: { full_title: string }[] };
    expect(Array.isArray(checkBody.quarantined)).toBe(true);
    expect(checkBody.quarantined.some((q) => q.full_title === fullTitle),
      "the just-added test should appear in /quarantine/check?suite=…").toBe(true);

    // ── List shows the entry, including the reason.
    const listRes = await page.request.get("http://localhost:3000/quarantine", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status()).toBe(200);
    const list = (await listRes.json()) as { full_title: string; reason: string | null }[];
    const entry = list.find((q) => q.full_title === fullTitle);
    expect(entry, "the quarantined test should be listed").toBeTruthy();
    expect(entry!.reason).toBe(reason);

    // ── Re-adding the same (suite, fullTitle) is an upsert — updates
    //    the reason without creating a duplicate row.
    const updatedReason = "still flaky; under investigation in JIRA-42";
    const reAddRes = await page.request.post("http://localhost:3000/quarantine", {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { fullTitle, filePath, suiteName, reason: updatedReason },
    });
    expect(reAddRes.status()).toBe(201);

    const listAfterReAdd = (await (
      await page.request.get("http://localhost:3000/quarantine", {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { full_title: string; reason: string | null }[];
    const dupes = listAfterReAdd.filter((q) => q.full_title === fullTitle);
    expect(dupes.length, "re-adding must upsert, not insert a duplicate").toBe(1);
    expect(dupes[0].reason).toBe(updatedReason);

    // ── Remove.
    const delRes = await page.request.delete("http://localhost:3000/quarantine", {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { fullTitle, suiteName },
    });
    expect(delRes.status()).toBe(200);
    expect(((await delRes.json()) as { quarantined: boolean }).quarantined).toBe(false);

    // ── /quarantine/check no longer lists this test.
    const checkAfter = await (
      await page.request.get(
        `http://localhost:3000/quarantine/check?suite=${encodeURIComponent(suiteName)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
    ).json();
    expect(
      (checkAfter.quarantined as { full_title: string }[]).some((q) => q.full_title === fullTitle),
      "after removal, the test should no longer be in /quarantine/check",
    ).toBe(false);

    // ── List no longer contains it.
    const listFinal = (await (
      await page.request.get("http://localhost:3000/quarantine", {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { full_title: string }[];
    expect(listFinal.find((q) => q.full_title === fullTitle), "removed entry must be gone from /quarantine").toBeUndefined();
  });

  test("quarantine list is per-org: an entry added by acme is invisible to demo-team", async ({ browser }) => {
    test.setTimeout(45_000);
    const acmeCtx = await browser.newContext({ storageState: ADMIN_USER.storageStatePath });
    const demoCtx = await browser.newContext({ storageState: DEMO_USER.storageStatePath });

    try {
      const acmePage = await acmeCtx.newPage();
      const demoPage = await demoCtx.newPage();
      await Promise.all([acmePage.goto("/dashboard"), demoPage.goto("/dashboard")]);
      const acmeJwt = await getToken(acmePage);
      const demoJwt = await getToken(demoPage);

      const fullTitle = `acme-only-quarantine ${Date.now()}`;
      const suiteName = "tenancy-q-suite";

      await acmePage.request.post("http://localhost:3000/quarantine", {
        headers: { Authorization: `Bearer ${acmeJwt}`, "Content-Type": "application/json" },
        data: { fullTitle, suiteName, reason: "should NEVER leak to demo-team" },
      });

      const demoList = (await (
        await demoPage.request.get("http://localhost:3000/quarantine", {
          headers: { Authorization: `Bearer ${demoJwt}` },
        })
      ).json()) as { full_title: string; reason: string | null }[];
      expect(demoList.find((q) => q.full_title === fullTitle), "acme's quarantine entry must NOT appear in demo's list").toBeUndefined();
      // And the reason text must NEVER appear anywhere in demo's response.
      expect(JSON.stringify(demoList)).not.toContain("should NEVER leak");

      // Cleanup.
      await acmePage.request.delete("http://localhost:3000/quarantine", {
        headers: { Authorization: `Bearer ${acmeJwt}`, "Content-Type": "application/json" },
        data: { fullTitle, suiteName },
      });
    } finally {
      await acmeCtx.close();
      await demoCtx.close();
    }
  });
});

/* ───────────────────── 3. Test prediction ───────────────────── */

test.describe("predict — POST /predict/tests with changed file paths", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("returns a ranked test list with deterministic shape (tests array, each entry has full_title + score)", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const res = await page.request.post("http://localhost:3000/predict/tests", {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { changedFiles: ["src/auth/login.ts", "src/api/users.ts"] },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      tests?: Array<{ full_title: string; score: number; suite_name?: string }>;
      [k: string]: unknown;
    };

    expect(Array.isArray(body.tests), "response.tests should be an array").toBe(true);
    if (body.tests!.length > 0) {
      // Every entry must carry the contract fields the MCP tool relies on.
      for (const t of body.tests!) {
        expect(typeof t.full_title).toBe("string");
        expect(typeof t.score).toBe("number");
        expect(t.score, "scores should be in [0, 1] (Jaccard-style)").toBeGreaterThanOrEqual(0);
        expect(t.score).toBeLessThanOrEqual(1);
      }
      // Tests should be sorted by score DESC.
      for (let i = 1; i < body.tests!.length; i++) {
        expect(
          body.tests![i].score,
          "tests must be sorted by score descending so callers can pick a top-N",
        ).toBeLessThanOrEqual(body.tests![i - 1].score);
      }
    }
  });

  test("empty changedFiles is rejected with 400 (the contract: 'changedFiles array is required')", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const res = await page.request.post("http://localhost:3000/predict/tests", {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { changedFiles: [] },
    });
    expect(res.status(), "empty changedFiles is the wrong shape — endpoint correctly returns 400").toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/changedFiles/i);
  });

  test("missing changedFiles is rejected with 400 (defensive — body shape check before the SQL)", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.goto("/dashboard");
    const token = await getToken(page);
    const res = await page.request.post("http://localhost:3000/predict/tests", {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test("the response is sorted by score DESC so callers can pick a top-N off the front of the list", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    // Use multiple changedFiles to maximise the chance the prediction
    // returns a mix of historical_failures and path_match candidates,
    // which is what exposes a sort-by-failure-count vs sort-by-score
    // discrepancy.
    const res = await page.request.post("http://localhost:3000/predict/tests", {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: {
        changedFiles: [
          "src/auth/login.ts",
          "src/api/users.ts",
          "src/checkout/payment.ts",
        ],
      },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { tests: { score: number }[] };
    for (let i = 1; i < body.tests.length; i++) {
      expect(
        body.tests[i].score,
        "tests must be sorted by score descending; otherwise top-N picks the wrong rows",
      ).toBeLessThanOrEqual(body.tests[i - 1].score);
    }
  });
});
