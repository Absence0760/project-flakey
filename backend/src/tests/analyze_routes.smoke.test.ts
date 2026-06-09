/**
 * Smoke tests for the AI-analysis routes (src/routes/analyze.ts).
 *
 * Protects the client workflow behind the error/flaky panel: the frontend
 * asks for AI analysis (cached per org) and for a "similar failures" list.
 *
 * The AI provider is OFF in the test environment (no AI_PROVIDER /
 * ANTHROPIC_API_KEY set), so the two AI endpoints cannot produce a real
 * result — and we do NOT mock one. We assert their *honest* disabled
 * behavior instead:
 *
 *   - POST /analyze/error/:fingerprint and POST /analyze/flaky validate input
 *     and resolve the cache / fingerprint BEFORE gating on isAIEnabled() (see
 *     analyze.ts), so the request-shape errors are reachable regardless of AI
 *     config: a missing fullTitle → 400, an unknown fingerprint → 404. Only a
 *     well-formed request that resolves to a real target and has no cached
 *     analysis reaches the AI gate, which (AI off) returns 503 with the
 *     documented "AI analysis requires an AI provider to be configured".
 *     POST /analyze/test/:testId behaves the same way, keyed by test id: an
 *     invalid id → 400, an unknown / non-failed id → 404, a real failed test
 *     with no cached analysis → 503.
 *
 *   - POST /analyze/similar/:fingerprint is fully deterministic: it uses
 *     computeSimilarity() over stored error fingerprints (NOT the AI
 *     provider), so it works regardless of AI config. This file exercises
 *     the real similarity contract end to end: threshold (> 0.3, strict),
 *     boundary (exactly 0.3 excluded), DESC ordering, DISTINCT-ON dedup,
 *     and 404 for an unknown fingerprint.
 *
 * Each test creates its own org + uploads its own runs, so assertions are
 * deterministic and independent of seed data and of other test agents.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import crypto from "node:crypto";
import pg from "pg";

const PORT = 3950;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let token: string;
let orgId: number;
let suiteName: string;
// Superuser client (bypasses RLS) used only to seed a cached analysis row —
// AI is off in this env, so the cache can't be populated through the route.
let dbAdmin: pg.Client;

// Error messages crafted against computeSimilarity (Jaccard-ish:
// intersection / max(|tokensA|, |tokensB|), tokens lowercased + punctuation
// stripped). The target has 5 unique tokens.
const TARGET_MSG = "alpha beta gamma delta epsilon"; // 5 tokens
// vs target: intersection {alpha,beta,delta,epsilon}=4, max=5 => 0.8  (included)
const HIGH_MSG = "alpha beta delta epsilon zeta";
// vs target: intersection {alpha,beta}=2, max=5 => 0.4  (included, just above 0.3)
const JUST_ABOVE_MSG = "alpha beta one two three";
// vs target: intersection {alpha,beta,gamma}=3, max=10 => 0.3 exactly
//            (EXCLUDED — filter is strictly > 0.3)
const BOUNDARY_MSG = "alpha beta gamma w1 w2 w3 w4 w5 w6 w7";
// vs target: no shared tokens => 0.0  (excluded)
const ZERO_MSG = "zzz yyy xxx www vvv";

function fingerprintOf(message: string, suite: string): string {
  return crypto.createHash("md5").update(`${message}|${suite}`).digest("hex");
}

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

function post(path: string, body: unknown) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

// Upload one run whose failed tests carry the given error messages.
// Each failed test gets a distinct full_title so they're real, separate rows.
async function uploadFailures(messages: string[], suite: string = suiteName): Promise<void> {
  const fd = new FormData();
  const tests = messages.map((message, i) => ({
    title: `case ${i}`,
    full_title: `Suite > case ${i} ${crypto.randomUUID()}`,
    status: "failed",
    duration_ms: 10,
    screenshot_paths: [],
    error: { message, stack: "at line 1" },
  }));
  fd.append(
    "payload",
    JSON.stringify({
      meta: {
        suite_name: suite,
        branch: "main",
        commit_sha: crypto.randomUUID().slice(0, 8),
        ci_run_id: `ci-analyze-${crypto.randomUUID()}`,
        started_at: "2026-04-10T00:00:00Z",
        finished_at: "2026-04-10T00:00:30Z",
        reporter: "mochawesome",
      },
      stats: {
        total: messages.length,
        passed: 0,
        failed: messages.length,
        skipped: 0,
        pending: 0,
        duration_ms: 30000,
      },
      specs: [
        {
          file_path: "analyze.cy.ts",
          title: "analyze",
          stats: { total: messages.length, passed: 0, failed: messages.length, skipped: 0, duration_ms: 30000 },
          tests,
        },
      ],
    })
  );
  const up = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!up.ok) throw new Error(`upload failed: ${up.status} ${await up.text().catch(() => "")}`);
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "analyze-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      // Defensively force AI off regardless of any ambient env, so the
      // "AI disabled" assertions are deterministic for this process.
      AI_PROVIDER: "",
      ANTHROPIC_API_KEY: "",
      AI_BASE_URL: "",
      AI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  // Fresh org so we own all the error data we query.
  const email = `analyze+${Date.now()}@test.local`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "testpass123",
      name: "Analyze",
      org_name: `AnalyzeOrg-${Date.now()}`,
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text().catch(() => "")}`);
  const regData = (await reg.json()) as { token: string; user: { orgId: number } };
  token = regData.token;
  orgId = regData.user.orgId;

  dbAdmin = new pg.Client({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5432),
    user: "flakey",
    password: "flakey",
    database: process.env.DB_NAME ?? "flakey",
  });
  await dbAdmin.connect();

  suiteName = `analyze-suite-${Date.now()}`;

  // First upload: the target plus the four comparison messages, one each.
  await uploadFailures([TARGET_MSG, HIGH_MSG, JUST_ABOVE_MSG, BOUNDARY_MSG, ZERO_MSG]);
  // Second upload: a duplicate of HIGH_MSG in another run. Since /similar
  // uses DISTINCT ON (error_message), this must NOT produce a second
  // HIGH_MSG row in the result — proving dedup.
  await uploadFailures([HIGH_MSG]);
});

after(async () => {
  if (dbAdmin) await dbAdmin.end().catch(() => {});
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── AI status (sanity: confirms AI really is OFF in this env) ─────────────

test("GET /analyze/status reports AI disabled in the test env", async () => {
  const res = await fetch(`${BASE}/analyze/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { enabled: boolean };
  assert.equal(data.enabled, false, "AI must be disabled in the test env for these assertions to hold");
});

// ── POST /analyze/error/:fingerprint ──────────────────────────────────────

test("POST /analyze/error/:fingerprint reaches the AI gate (503) for a real, uncached fingerprint when AI is off", async () => {
  // A real uploaded error fingerprint resolves the lookup (cache miss → found),
  // so the request reaches the AI gate, which is off → 503.
  const fp = fingerprintOf(TARGET_MSG, suiteName);
  const res = await post(`/analyze/error/${fp}`, {});
  assert.equal(res.status, 503);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "AI analysis requires an AI provider to be configured");
});

test("POST /analyze/error/:fingerprint returns 404 for an unknown fingerprint (resolution precedes the AI gate)", async () => {
  // The fingerprint lookup runs before the isAIEnabled() gate, so an unknown
  // fingerprint 404s with the documented message regardless of AI config.
  const res = await post(`/analyze/error/${"0".repeat(32)}`, {});
  assert.equal(res.status, 404);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "Error not found");
});

// ── POST /analyze/test/:testId ────────────────────────────────────────────

test("POST /analyze/test/:testId reaches the AI gate (503) for a real failed test when AI is off", async () => {
  // Resolve a real failed-test id from our uploaded data via the affected-tests
  // endpoint, then analyze it. It resolves to a real error fingerprint with no
  // cached analysis, so it reaches the AI gate, which is off → 503.
  const fp = fingerprintOf(TARGET_MSG, suiteName);
  const listed = await fetch(`${BASE}/errors/${fp}/tests`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(listed.status, 200);
  const tests = (await listed.json()) as Array<{ latest_test_id: number }>;
  assert.ok(tests.length > 0 && tests[0].latest_test_id, "expected a real failed-test id from the affected-tests list");

  const res = await post(`/analyze/test/${tests[0].latest_test_id}`, {});
  assert.equal(res.status, 503);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "AI analysis requires an AI provider to be configured");
});

test("POST /analyze/test/:testId returns 400 for a non-numeric id (validation precedes the AI gate)", async () => {
  const res = await post(`/analyze/test/not-a-number`, {});
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "Invalid test id");
});

test("POST /analyze/test/:testId returns 404 for an unknown test id (resolution precedes the AI gate)", async () => {
  // A valid-but-nonexistent id (also covers cross-org: RLS scopes the lookup,
  // so a foreign id simply resolves to no rows) → 404 regardless of AI config.
  const res = await post(`/analyze/test/2000000000`, {});
  assert.equal(res.status, 404);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "Failed test with an error message not found");
});

// ── POST /analyze/flaky ───────────────────────────────────────────────────

test("POST /analyze/flaky reaches the AI gate (503) for a well-formed, uncached request when AI is off", async () => {
  const res = await post(`/analyze/flaky`, {
    fullTitle: "Suite > some flaky test",
    suiteName,
  });
  assert.equal(res.status, 503);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "AI analysis requires an AI provider to be configured");
});

test("POST /analyze/flaky cache hit returns the shaped contract, never the raw DB row", async () => {
  // Seed a cached flaky analysis directly (AI is off, so the route can't write
  // one). The cache-hit path must return the SAME shape as fresh generation
  // (target_type/target_key + the FlakyAnalysis fields) and must NOT leak the
  // internal columns id / org_id / raw_result / created_at — raw_result echoes
  // the prompt's error text, so returning it is a PII regression (audit fix).
  const fullTitle = `Suite > cached flaky ${crypto.randomUUID()}`;
  const cacheKey = `${fullTitle}|${suiteName}`;
  const rawResult = {
    rootCause: "race on shared fixture",
    stabilizationSuggestion: "await the network idle signal",
    shouldQuarantine: true,
    severity: "high",
    // A field that would expose prompt content if the row were returned wholesale.
    leakedPromptEcho: "SELECT * from prod where secret='do-not-surface'",
  };
  await dbAdmin.query(
    `INSERT INTO ai_analyses (org_id, target_type, target_key, classification, summary, suggested_fix, confidence, raw_result)
     VALUES ($1, 'flaky', $2, $3, $4, $5, $6, $7)`,
    [orgId, cacheKey, "high", rawResult.rootCause, rawResult.stabilizationSuggestion, 1, JSON.stringify(rawResult)]
  );

  const res = await post(`/analyze/flaky`, { fullTitle, suiteName });
  assert.equal(res.status, 200, "a seeded cache row must serve a 200 even with AI off");
  const body = (await res.json()) as Record<string, unknown>;

  // Shaped fields match the fresh-generation contract.
  assert.equal(body.target_type, "flaky");
  assert.equal(body.target_key, cacheKey);
  assert.equal(body.severity, "high");
  assert.equal(body.rootCause, rawResult.rootCause);
  assert.equal(body.stabilizationSuggestion, rawResult.stabilizationSuggestion);
  assert.equal(body.shouldQuarantine, true, "confidence=1 must map back to shouldQuarantine=true");

  // The leak the audit flagged: internal columns must be absent.
  for (const leaked of ["id", "org_id", "raw_result", "created_at", "classification", "summary", "suggested_fix", "confidence"]) {
    assert.ok(!(leaked in body), `cache-hit response must not expose '${leaked}'`);
  }
  // Belt + suspenders: the prompt echo stashed in raw_result must not surface anywhere.
  assert.ok(!JSON.stringify(body).includes("do-not-surface"), "raw_result content leaked into the response");
});

test("POST /analyze/flaky returns 400 for a missing fullTitle (validation precedes the AI gate)", async () => {
  // Input validation runs before the isAIEnabled() gate, so a malformed
  // request 400s with the documented message regardless of AI config.
  const res = await post(`/analyze/flaky`, { suiteName });
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "fullTitle is required");
});

// ── POST /analyze/similar/:fingerprint (deterministic, no AI) ─────────────

test("POST /analyze/similar/:fingerprint returns similar failures with similarity in (0.3, 1.0)", async () => {
  const fp = fingerprintOf(TARGET_MSG, suiteName);
  const res = await post(`/analyze/similar/${fp}`, {});
  assert.equal(res.status, 200);
  const rows = (await res.json()) as Array<{
    fingerprint: string;
    error_message: string;
    suite_name: string;
    occurrence_count: number;
    similarity: number;
    status: string;
  }>;
  assert.ok(Array.isArray(rows), "response must be an array");

  // HIGH_MSG (0.8) must appear.
  const high = rows.find((r) => r.error_message === HIGH_MSG);
  assert.ok(high, "the high-similarity failure (0.8) should be returned");
  assert.ok(high!.similarity > 0.3 && high!.similarity < 1.0,
    `similarity should be in (0.3, 1.0), got ${high!.similarity}`);

  // The target itself must NOT appear (its own fingerprint is excluded).
  assert.ok(!rows.some((r) => r.error_message === TARGET_MSG),
    "the target error must be excluded from its own similar list");

  // Result rows carry the documented shape.
  assert.equal(typeof high!.fingerprint, "string");
  assert.equal(high!.suite_name, suiteName);
  assert.ok(Number.isFinite(high!.occurrence_count));
  assert.equal(typeof high!.status, "string");
});

test("POST /analyze/similar enforces the 0.3 threshold: just-above included, exactly-0.3 excluded", async () => {
  const fp = fingerprintOf(TARGET_MSG, suiteName);
  const res = await post(`/analyze/similar/${fp}`, {});
  assert.equal(res.status, 200);
  const rows = (await res.json()) as Array<{ error_message: string }>;

  // JUST_ABOVE_MSG has similarity 0.4 (> 0.3) → included.
  assert.ok(rows.some((r) => r.error_message === JUST_ABOVE_MSG),
    "the 0.4-similarity failure should be included (strictly above the 0.3 threshold)");

  // BOUNDARY_MSG has similarity exactly 0.3 → excluded (filter is `> 0.3`).
  assert.ok(!rows.some((r) => r.error_message === BOUNDARY_MSG),
    "the exactly-0.3 failure should be excluded (threshold is strictly greater-than)");

  // ZERO_MSG shares no tokens (0.0) → excluded.
  assert.ok(!rows.some((r) => r.error_message === ZERO_MSG),
    "the zero-similarity failure should be excluded");
});

test("POST /analyze/similar returns results sorted by similarity DESC", async () => {
  const fp = fingerprintOf(TARGET_MSG, suiteName);
  const res = await post(`/analyze/similar/${fp}`, {});
  assert.equal(res.status, 200);
  const rows = (await res.json()) as Array<{ similarity: number; error_message: string }>;

  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].similarity >= rows[i].similarity,
      `results must be DESC by similarity: ${rows[i - 1].similarity} < ${rows[i].similarity}`);
  }
  // Concretely, HIGH_MSG (0.8) must rank before JUST_ABOVE_MSG (0.4).
  const idxHigh = rows.findIndex((r) => r.error_message === HIGH_MSG);
  const idxAbove = rows.findIndex((r) => r.error_message === JUST_ABOVE_MSG);
  assert.ok(idxHigh !== -1 && idxAbove !== -1, "both similar failures should be present");
  assert.ok(idxHigh < idxAbove, "the more-similar failure should sort first");
});

test("POST /analyze/similar dedups identical error messages via DISTINCT ON", async () => {
  // HIGH_MSG was uploaded in two separate runs. DISTINCT ON (error_message)
  // must collapse it to a single row in the result.
  const fp = fingerprintOf(TARGET_MSG, suiteName);
  const res = await post(`/analyze/similar/${fp}`, {});
  assert.equal(res.status, 200);
  const rows = (await res.json()) as Array<{ error_message: string }>;
  const highCount = rows.filter((r) => r.error_message === HIGH_MSG).length;
  assert.equal(highCount, 1, "duplicate error messages must be collapsed to one row");
});

test("POST /analyze/similar: a message spanning suites collapses to its most-recent representative", async () => {
  // Contract test for the deterministic representative the query now guarantees.
  // The SAME error message in two suites has two fingerprints; DISTINCT ON
  // (error_message) keeps one, and the fix's inner ORDER BY (error_message,
  // created_at DESC, t.id DESC) makes that one the MOST-RECENT occurrence.
  //
  // NOTE: this pins the forward contract — it does NOT reliably fail against the
  // pre-fix no-ORDER-BY query, because DISTINCT ON without ORDER BY is
  // plan-dependent and can coincidentally return the most-recent row anyway.
  // Nondeterminism isn't reliably catchable behaviourally; what this guards is
  // that a future change can't quietly flip the representative (e.g. to oldest).
  // SHARED is 0.8-similar to TARGET_MSG, so it clears the > 0.3 threshold.
  const SHARED = "alpha beta gamma delta omega";
  const oldSuite = `xsuite-old-${Date.now()}`;
  const newSuite = `xsuite-new-${Date.now()}`;

  await uploadFailures([SHARED], oldSuite);
  await uploadFailures([SHARED], newSuite);

  const fp = fingerprintOf(TARGET_MSG, suiteName);
  const first = (await (await post(`/analyze/similar/${fp}`, {})).json()) as Array<{ error_message: string; suite_name: string }>;
  const second = (await (await post(`/analyze/similar/${fp}`, {})).json()) as typeof first;

  // Stable across identical calls.
  assert.deepEqual(first, second, "two identical /similar calls must return identical results");

  // SHARED collapses to exactly one row (dedup preserved) ...
  const sharedRows = first.filter((r) => r.error_message === SHARED);
  assert.equal(sharedRows.length, 1, "the cross-suite message must collapse to one row");
  // ... whose representative is the most-recent occurrence's suite.
  assert.equal(
    sharedRows[0].suite_name,
    newSuite,
    "the representative must be the most-recent occurrence's suite",
  );
});

test("POST /analyze/similar/:fingerprint returns 404 for a non-existent fingerprint", async () => {
  const res = await post(`/analyze/similar/${"f".repeat(32)}`, {});
  assert.equal(res.status, 404);
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "Error not found");
});
