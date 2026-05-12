import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { ADMIN_USER } from "../fixtures/users";

/**
 * E2E coverage for the post-run-only example tools (Selenium, Jest,
 * Postman, ZAP). These don't have a live-streaming integration —
 * they upload after the test run completes via either:
 *   - mochawesome JSON (Selenium-style)
 *   - JUnit XML (Jest, Postman/Newman, ZAP all converge here)
 *
 * The earlier rounds covered the live half. This file pins the
 * post-run upload + dashboard render path for each tool so a
 * regression in normalizers/{mochawesome,junit,jest}.ts trips a test
 * before users notice their dashboards going empty.
 *
 * Each test:
 *   1. Builds a representative report payload for the tool.
 *   2. POSTs to /runs/upload with `{raw, meta}` (server-side normalize).
 *   3. Verifies the run lands with the right stats + spec/test rows.
 *   4. Loads /runs/<id> and asserts the UI renders the rows.
 *   5. Cleans up via DELETE /runs/<id>.
 */

const POLL_TIMEOUT = 10_000;

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

async function uploadRaw(
  request: APIRequestContext,
  token: string,
  reporter: string,
  raw: string | Record<string, unknown>,
  meta: { suite_name: string; ci_run_id?: string },
): Promise<{ id: number; merged?: boolean }> {
  const fullMeta = {
    suite_name: meta.suite_name,
    branch: "main",
    commit_sha: "example-tools",
    ci_run_id: meta.ci_run_id ?? `ex-${Date.now().toString(36)}`,
    started_at: new Date(Date.now() - 30_000).toISOString(),
    finished_at: new Date().toISOString(),
    reporter,
  };
  const res = await request.post("http://localhost:3000/runs/upload", {
    headers: { Authorization: `Bearer ${token}` },
    multipart: { payload: JSON.stringify({ raw, meta: fullMeta }) },
  });
  expect(res.status(), `upload via reporter=${reporter} should accept`).toBeLessThan(300);
  return res.json();
}

async function fetchRun(
  request: APIRequestContext,
  token: string,
  runId: number,
): Promise<any> {
  const r = await request.get(`http://localhost:3000/runs/${runId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(r.status()).toBe(200);
  return r.json();
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

/* ─────────────────────────────── 1. Selenium (mochawesome) ─────────────────────────────── */

test.describe("examples — Selenium upload via mochawesome JSON", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("a mochawesome report from Selenium's mocha runner uploads, normalises, and renders on the dashboard", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    // Mochawesome's actual output shape — per its docs + the parser
    // reads `results[].suites[].tests[]` with state in {"passed"|"failed"|"skipped"}.
    const mochawesomeReport = {
      stats: { tests: 4, passes: 2, failures: 1, pending: 1, duration: 350 },
      results: [{
        file: "tests/smoke/login.spec.ts",
        title: "tests/smoke/login.spec.ts",
        suites: [{
          title: "Login",
          tests: [
            {
              title: "should sign in",
              fullTitle: "Login should sign in",
              duration: 100,
              state: "passed",
              pass: true,
              fail: false,
              pending: false,
            },
            {
              title: "should reject empty pwd",
              fullTitle: "Login should reject empty pwd",
              duration: 50,
              state: "passed",
              pass: true,
              fail: false,
              pending: false,
            },
            {
              title: "should remember session",
              fullTitle: "Login should remember session",
              duration: 200,
              state: "failed",
              pass: false,
              fail: true,
              pending: false,
              err: { message: "Cookie not preserved", estack: "stack here" },
            },
            {
              title: "should support SSO",
              fullTitle: "Login should support SSO",
              duration: 0,
              state: "pending",
              pass: false,
              fail: false,
              pending: true,
            },
          ],
        }],
      }],
    };

    const result = await uploadRaw(page.request, token, "mochawesome", mochawesomeReport, {
      suite_name: `selenium-example-${Date.now().toString(36)}`,
    });
    const runId = result.id;

    const detail = await fetchRun(page.request, token, runId);
    expect(detail.specs.length).toBeGreaterThanOrEqual(1);
    const tests = detail.specs.flatMap((s: any) => s.tests);
    expect(tests.length).toBe(4);
    expect(tests.filter((t: any) => t.status === "passed").length).toBe(2);
    expect(tests.filter((t: any) => t.status === "failed").length).toBe(1);
    // Mocha's `pending` state surfaces as status='pending' on the row
    // (not 'skipped'); the run-level `skipped` counter folds them in.
    expect(tests.filter((t: any) => t.status === "pending").length).toBe(1);
    expect(detail.skipped, "run-level skipped includes pending rows per the mochawesome normaliser").toBe(1);
    const failedTest = tests.find((t: any) => t.status === "failed");
    expect(failedTest.error_message).toContain("Cookie not preserved");

    // Dashboard renders it.
    await page.goto(`/runs/${runId}`);
    // Detail page header lands the run id in the meta-row chip
    // (the polished layout dropped the redundant <h1>Run #N</h1>).
    await expect(
      page.locator(".run-header .meta-item", { hasText: new RegExp(`^\\s*#${runId}\\s*$`) }).first(),
    ).toBeVisible({ timeout: POLL_TIMEOUT });
    await expect(page.locator(".spec-section").first()).toBeVisible({ timeout: POLL_TIMEOUT });
    // 1 failed → status filter auto-lands on `failed`. Just confirm
    // the failed dot is visible.
    await expect.poll(
      async () => await page.locator(".test-status-dot.failed").count(),
      { timeout: POLL_TIMEOUT },
    ).toBeGreaterThanOrEqual(1);

    await deleteRun(page.request, token, runId);
  });
});

/* ─────────────────────────────── 2. Jest (JUnit) ─────────────────────────────── */

test.describe("examples — Jest upload via JUnit XML", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("a jest-junit report uploads, normalises, and renders correctly", async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    // jest-junit's typical output shape — wrapped in <testsuites>,
    // each <testsuite> per test file. Times are in seconds.
    const junitXml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="jest tests" tests="3" failures="1" time="0.45">
  <testsuite name="utils.test.ts" tests="3" failures="1" time="0.45" timestamp="2026-05-09T12:00:00">
    <testcase classname="utils sumNumbers" name="adds two positives" time="0.05" />
    <testcase classname="utils sumNumbers" name="returns 0 for empty" time="0.10">
      <failure message="Expected 0, received NaN" type="AssertionError">
Expected 0, received NaN
    at Object.&lt;anonymous&gt; (utils.test.ts:42:10)
      </failure>
    </testcase>
    <testcase classname="utils sumNumbers" name="ignores non-number entries" time="0.30" />
  </testsuite>
</testsuites>`;

    const result = await uploadRaw(page.request, token, "junit", junitXml, {
      suite_name: `jest-example-${Date.now().toString(36)}`,
    });
    const runId = result.id;

    const detail = await fetchRun(page.request, token, runId);
    expect(detail.passed).toBe(2);
    expect(detail.failed).toBe(1);
    expect(detail.total).toBe(3);
    const tests = detail.specs.flatMap((s: any) => s.tests);
    const failed = tests.find((t: any) => t.status === "failed");
    expect(failed.error_message).toContain("Expected 0, received NaN");
    expect(failed.duration_ms, "JUnit time='0.10' should normalise to 100ms (seconds → ms)").toBe(100);

    await deleteRun(page.request, token, runId);
  });
});

/* ─────────────────────────────── 3. Postman / Newman (JUnit) ─────────────────────────────── */

test.describe("examples — Postman/Newman upload via JUnit XML", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("a Newman JUnit report (one <testsuite> per request, testcase per assertion) uploads cleanly", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    // Newman writes one <testsuite> per request and a <testcase> per
    // assertion. Status codes show up as their own assertions.
    const junitXml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="API Smoke Suite" tests="4" failures="1" time="1.20">
  <testsuite name="GET /users" tests="2" failures="0" time="0.40">
    <testcase classname="GET /users" name="returns 200" time="0.20" />
    <testcase classname="GET /users" name="response is JSON" time="0.20" />
  </testsuite>
  <testsuite name="POST /users" tests="2" failures="1" time="0.80">
    <testcase classname="POST /users" name="returns 201" time="0.30" />
    <testcase classname="POST /users" name="response includes new id" time="0.50">
      <failure message="response.id was undefined" type="AssertionError">
expected response.id to be defined
      </failure>
    </testcase>
  </testsuite>
</testsuites>`;

    const result = await uploadRaw(page.request, token, "junit", junitXml, {
      suite_name: `postman-example-${Date.now().toString(36)}`,
    });
    const runId = result.id;

    const detail = await fetchRun(page.request, token, runId);
    expect(detail.specs.length, "two requests = two specs").toBe(2);
    expect(detail.passed).toBe(3);
    expect(detail.failed).toBe(1);

    const failedSpec = detail.specs.find((s: any) =>
      s.tests.some((t: any) => t.status === "failed"),
    );
    expect(failedSpec, "one of the specs must contain the failed assertion").toBeTruthy();
    const failed = failedSpec.tests.find((t: any) => t.status === "failed");
    expect(failed.error_message).toContain("undefined");

    await deleteRun(page.request, token, runId);
  });
});

/* ─────────────────────────────── 4. OWASP ZAP (JUnit) ─────────────────────────────── */

test.describe("examples — OWASP ZAP upload via JUnit XML", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("a ZAP-style JUnit report (one testcase per finding, classname=alert risk) uploads cleanly", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    // ZAP's convert.js produces a JUnit XML where each scan finding
    // is a testcase, classified by risk (high/medium/low/info). High-
    // and medium-risk alerts arrive as failures; informational ones
    // pass.
    const junitXml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="ZAP API scan" tests="5" failures="2" time="12.50">
  <testsuite name="High risk findings" tests="2" failures="2" time="0.0">
    <testcase classname="HIGH" name="SQL Injection" time="0.0">
      <failure message="SQL Injection detected at /api/search?q=" type="HIGH">
Severity: High
URL: https://target.test/api/search?q=
Description: The page parameter is vulnerable to SQL injection.
      </failure>
    </testcase>
    <testcase classname="HIGH" name="Cross Site Scripting (Reflected)" time="0.0">
      <failure message="Reflected XSS at /api/echo" type="HIGH" />
    </testcase>
  </testsuite>
  <testsuite name="Medium risk findings" tests="0" failures="0" time="0.0" />
  <testsuite name="Informational findings" tests="3" failures="0" time="0.0">
    <testcase classname="INFO" name="Modern Web Application" time="0.0" />
    <testcase classname="INFO" name="Strict-Transport-Security Header Set" time="0.0" />
    <testcase classname="INFO" name="X-Content-Type-Options Header Set" time="0.0" />
  </testsuite>
</testsuites>`;

    const result = await uploadRaw(page.request, token, "junit", junitXml, {
      suite_name: `zap-example-${Date.now().toString(36)}`,
    });
    const runId = result.id;

    const detail = await fetchRun(page.request, token, runId);
    expect(detail.failed, "two HIGH alerts → two failures").toBe(2);
    expect(detail.passed, "three informational findings → three passed").toBe(3);

    const tests = detail.specs.flatMap((s: any) => s.tests);
    const sqlInjection = tests.find((t: any) => t.title === "SQL Injection");
    expect(sqlInjection.status).toBe("failed");
    expect(sqlInjection.error_message).toContain("SQL Injection");

    await deleteRun(page.request, token, runId);
  });
});

/* ─────────────────────────────── 5. Cross-tool: identical ci_run_id merges into one run ─────────────────────────────── */

test.describe("examples — same ci_run_id across tools merges into one run", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("a Jest unit-test report and a Postman API-test report sharing (suite, ci_run_id) merge into one run with both spec sets", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const sharedSuite = `merged-${Date.now().toString(36)}`;
    const sharedCiRunId = `ci-merged-${Date.now().toString(36)}`;

    const jestXml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="jest" tests="1" failures="0" time="0.05">
  <testsuite name="utils.test.ts" tests="1" failures="0" time="0.05">
    <testcase classname="utils" name="adds positives" time="0.05" />
  </testsuite>
</testsuites>`;

    const postmanXml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="newman" tests="1" failures="0" time="0.10">
  <testsuite name="GET /healthz" tests="1" failures="0" time="0.10">
    <testcase classname="GET /healthz" name="returns 200" time="0.10" />
  </testsuite>
</testsuites>`;

    const r1 = await uploadRaw(page.request, token, "junit", jestXml, {
      suite_name: sharedSuite, ci_run_id: sharedCiRunId,
    });
    const r2 = await uploadRaw(page.request, token, "junit", postmanXml, {
      suite_name: sharedSuite, ci_run_id: sharedCiRunId,
    });

    expect(r1.id, "second upload must merge into the first run, not create a new one").toBe(r2.id);
    expect(r2.merged, "second upload should report merged=true").toBe(true);

    // Both spec sets are present.
    const detail = await fetchRun(page.request, token, r1.id);
    const filePaths = detail.specs.map((s: any) => s.file_path).sort();
    expect(filePaths, "both unit-test and API-test spec rows should be on the merged run").toEqual([
      "GET /healthz",
      "utils.test.ts",
    ]);
    expect(detail.passed).toBe(2);

    await deleteRun(page.request, token, r1.id);
  });
});
