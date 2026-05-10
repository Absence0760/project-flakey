// End-to-end ingest smoke for every reporter format the examples
// produce. Each test under examples/ runs its native reporter and
// hands the output to either the CLI or a direct curl upload — the
// path they all converge on is POST /runs/upload with
// {raw, meta: { reporter }}, which normalizes server-side via
// backend/src/normalizers/.
//
// parsers_realistic.unit.test.ts already exercises each normalizer
// in isolation. The gap this file fills is the FULL pipeline:
// upload-route auth → multipart parse → normalize() dispatch →
// findOrCreateRun → tests/specs INSERT → GET /runs/:id round-trip.
// A regression in any of those (e.g. a typo on the upload route's
// reporter dispatch, an FK on specs that breaks under a parser
// edge case, a missing column the normalizer outputs) would slip
// past the unit tests but break every example consumer.
//
// One test per reporter: mochawesome (Cypress example),
// playwright (Playwright example), jest (Jest example), junit
// (Selenium / Jest fallback / Newman / Postman example), and
// webdriverio (WDIO example via a hand-built minimal payload —
// no realistic fixture exists for it).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PORT = 3976;
const BASE = `http://localhost:${PORT}`;
const FIXTURES = join(import.meta.dirname, "fixtures");

let server: ChildProcess;
let token: string;

async function waitForHealth(maxMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Backend did not become healthy in time");
}

interface RunDetail {
  reporter: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  pending: number;
  specs: Array<{ file_path: string; tests: Array<{ title: string; status: string }> }>;
}

async function postRawUpload(raw: unknown, reporter: string, suite: string): Promise<RunDetail> {
  const fd = new FormData();
  fd.append(
    "payload",
    JSON.stringify({
      raw,
      meta: {
        suite_name: suite,
        branch: "main",
        commit_sha: `sha-${suite}`,
        ci_run_id: `ci-${suite}-${Date.now()}`,
        started_at: "2026-05-10T00:00:00Z",
        finished_at: "2026-05-10T00:00:10Z",
        reporter,
      },
    }),
  );
  const up = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!up.ok) {
    const body = await up.text().catch(() => "");
    throw new Error(`/runs/upload (${reporter}) failed: ${up.status} ${body}`);
  }
  const { id } = (await up.json()) as { id: number };
  const detail = await fetch(`${BASE}/runs/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!detail.ok) throw new Error(`/runs/${id} read failed: ${detail.status}`);
  return (await detail.json()) as RunDetail;
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "examples-ingest-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      AUTH_RATE_LIMIT_MAX: "500",
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `examples-ingest+${Date.now()}@test.local`,
      password: "testpass123",
      name: "Examples Ingest",
      org_name: `ExamplesIngestOrg-${Date.now()}`,
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
  token = ((await reg.json()) as { token: string }).token;
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── Mochawesome (examples/cypress) ──────────────────────────────────────

test("POST /runs/upload ingests a realistic Mochawesome report and the run reads back with the right counts (examples/cypress)", async () => {
  // The Cypress example's reporter outputs Mochawesome JSON.
  // Expected per parsers_realistic.unit.test.ts:
  //   - 4 specs (one empty result row included)
  //   - 5 tests total, 3 passed, 1 failed
  const raw = JSON.parse(readFileSync(join(FIXTURES, "mochawesome.cypress-realistic.json"), "utf-8"));
  const detail = await postRawUpload(raw, "mochawesome", `cypress-${Date.now()}`);

  assert.equal(detail.reporter, "mochawesome", "the run row must record the reporter that ingested it");
  assert.equal(detail.specs.length, 4, "every Mochawesome result entry (including empty ones) must materialize a spec row");
  assert.equal(detail.total, 5, "Mochawesome fixture has 5 real tests");
  assert.equal(detail.passed, 3, "Mochawesome fixture has 3 passing tests");
  assert.equal(detail.failed, 1, "Mochawesome fixture has 1 failing test");
});

// ── Playwright (examples/playwright) ────────────────────────────────────

test("POST /runs/upload ingests a realistic Playwright JSON report (examples/playwright)", async () => {
  const raw = JSON.parse(readFileSync(join(FIXTURES, "playwright.realistic.json"), "utf-8"));
  const detail = await postRawUpload(raw, "playwright", `playwright-${Date.now()}`);

  assert.equal(detail.reporter, "playwright");
  assert.ok(detail.specs.length >= 1, "Playwright fixture must produce at least one spec");
  assert.ok(detail.total > 0, "Playwright fixture must produce at least one test row");
  // Retries collapse to the last result per parsers_realistic.unit.test.ts,
  // so the number of test rows equals the number of distinct tests, not
  // the number of retries. Sanity-check: total = passed + failed + skipped + pending.
  assert.equal(
    detail.total,
    detail.passed + detail.failed + detail.skipped + detail.pending,
    "stats must add up across the four buckets — a mismatch means a test row landed without a status",
  );
});

// ── Jest (examples/jest) ────────────────────────────────────────────────

test("POST /runs/upload ingests a realistic Jest JSON report (examples/jest)", async () => {
  // Per parsers_realistic.unit.test.ts:
  //   total=6, passed=3, failed=2, pending=1
  const raw = JSON.parse(readFileSync(join(FIXTURES, "jest.realistic.json"), "utf-8"));
  const detail = await postRawUpload(raw, "jest", `jest-${Date.now()}`);

  assert.equal(detail.reporter, "jest");
  assert.equal(detail.total, 6, "Jest fixture has 6 real tests across the suites");
  assert.equal(detail.passed, 3);
  assert.equal(detail.failed, 2);
  assert.equal(detail.pending, 1);
});

// ── JUnit (examples/selenium, examples/jest fallback, etc.) ─────────────

test("POST /runs/upload ingests a realistic JUnit XML report — passed as a string (examples/selenium / fallback path)", async () => {
  // JUnit is XML, not JSON. The route's `raw` field accepts any
  // value (JSON.stringify wraps it in quotes), and the JUnit
  // parser is fed the string verbatim. Per parsers_realistic:
  //   total=7, failed=3, skipped>=1
  const xml = readFileSync(join(FIXTURES, "junit.realistic.xml"), "utf-8");
  const detail = await postRawUpload(xml, "junit", `junit-${Date.now()}`);

  assert.equal(detail.reporter, "junit");
  assert.equal(detail.total, 7, "JUnit fixture has 7 testcase entries (empty suite contributes 0)");
  assert.equal(detail.failed, 3, "<failure> + <error> both count as failed");
  assert.ok(detail.skipped >= 1, "<skipped> entries must be preserved as skipped, not dropped");
});

// ── WebdriverIO (examples/webdriverio) ──────────────────────────────────

test("POST /runs/upload ingests a minimal WDIO JSON report (examples/webdriverio)", async () => {
  // No realistic WDIO fixture lives in tests/fixtures/, so build a
  // representative one inline. Shape matches @wdio/json-reporter's
  // output (see backend/src/normalizers/webdriverio.ts WdioReport).
  const raw = {
    state: { passed: 2, failed: 1, skipped: 1 },
    specs: [
      {
        filename: "test/specs/login.e2e.ts",
        start: "2026-05-10T00:00:00Z",
        end: "2026-05-10T00:00:05Z",
        duration: 5000,
        suites: [
          {
            name: "Login flow",
            file: "test/specs/login.e2e.ts",
            tests: [
              {
                name: "should accept valid credentials",
                title: "should accept valid credentials",
                fullTitle: "Login flow > should accept valid credentials",
                state: "passed",
                duration: 1000,
              },
              {
                name: "should reject empty password",
                title: "should reject empty password",
                fullTitle: "Login flow > should reject empty password",
                state: "passed",
                duration: 800,
              },
              {
                name: "should not allow SQL injection in email",
                title: "should not allow SQL injection in email",
                fullTitle: "Login flow > should not allow SQL injection in email",
                state: "failed",
                duration: 1200,
                error: { message: "AssertionError: expected 200 to equal 401", stack: "stack" },
              },
              {
                name: "intermittent stability check",
                title: "intermittent stability check",
                fullTitle: "Login flow > intermittent stability check",
                state: "skipped",
                duration: 0,
              },
            ],
          },
        ],
      },
    ],
  };
  const detail = await postRawUpload(raw, "webdriverio", `wdio-${Date.now()}`);

  assert.equal(detail.reporter, "webdriverio");
  assert.equal(detail.total, 4, "the minimal WDIO payload has four tests across pass/fail/skip");
  assert.equal(detail.passed, 2);
  assert.equal(detail.failed, 1);
  assert.equal(detail.skipped, 1);
  // The failing test must surface its full title — that's what the
  // /errors fingerprint, the webhook payload, and the run-detail
  // page all key off.
  const allTitles = detail.specs.flatMap((s) => s.tests.map((t) => t.title));
  assert.ok(
    allTitles.includes("should not allow SQL injection in email"),
    "failing test title must round-trip through normalize → DB → /runs/:id",
  );
});

// ── Unsupported reporter is rejected cleanly ────────────────────────────

test("POST /runs/upload with an unknown reporter returns 400 (not 500)", async () => {
  // The route's normalize() throws on an unsupported reporter
  // name. The route's try/catch must convert that to a 4xx, not
  // let it surface as a 500 — an invalid CLI invocation should
  // produce a clear error, not look like a backend outage.
  const fd = new FormData();
  fd.append(
    "payload",
    JSON.stringify({
      raw: {},
      meta: {
        suite_name: "unknown-reporter",
        branch: "main",
        commit_sha: "x",
        ci_run_id: `unknown-${Date.now()}`,
        started_at: "2026-05-10T00:00:00Z",
        finished_at: "2026-05-10T00:00:01Z",
        reporter: "this-reporter-does-not-exist",
      },
    }),
  );
  const res = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  assert.ok(
    res.status >= 400 && res.status < 500,
    `unsupported reporter must 4xx; got ${res.status} — a 500 would mean the route lets normalize()'s throw escape unhandled`,
  );
});
