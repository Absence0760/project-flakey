// Notes + quarantine basic-functionality smoke.
//
// routes_reads.smoke.test.ts covers POST/GET /notes round-trip for
// the `run` target only, and `POST/GET/DELETE /quarantine
// round-trip` (single happy path). Two gaps left:
//
//   1. /notes supports three target_types — run / test / error — and
//      the route validates against that allow-list. Only `run` had
//      coverage. A regression that drops `test` or `error` from
//      VALID_TARGET_TYPES silently breaks the test-detail and
//      error-modal note panels in the UI.
//
//   2. /quarantine has a /check endpoint that the CI integration
//      calls to skip known-flaky tests on a fresh shard. No test
//      exercises /check or the upsert-on-re-quarantine path on POST.
//
// This file pins both.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3971;
const BASE = `http://localhost:${PORT}`;

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

function auth() {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "notes-quarantine-test-secret",
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
      email: `notes-q+${Date.now()}@test.local`,
      password: "testpass123",
      name: "Notes Q",
      org_name: `NotesQOrg-${Date.now()}`,
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

// ── /notes target_type coverage ─────────────────────────────────────────

test("POST /notes round-trips for target_type=test (test-detail page note panel)", async () => {
  const targetKey = `test-target-${Date.now()}`;
  const post = await fetch(`${BASE}/notes`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ target_type: "test", target_key: targetKey, body: "flagging this for review" }),
  });
  assert.equal(post.status, 201);

  const get = await fetch(`${BASE}/notes?target_type=test&target_key=${targetKey}`, { headers: auth() });
  assert.equal(get.status, 200);
  const rows = (await get.json()) as Array<{ body: string; target_type: string; target_key: string }>;
  assert.equal(rows.length, 1, "exactly the one note must come back");
  assert.equal(rows[0].body, "flagging this for review");
  assert.equal(rows[0].target_type, "test");
});

test("POST /notes round-trips for target_type=error (error-modal note panel)", async () => {
  const targetKey = `err-fingerprint-${Date.now()}`;
  const post = await fetch(`${BASE}/notes`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ target_type: "error", target_key: targetKey, body: "see Jira FLAKEY-42" }),
  });
  assert.equal(post.status, 201);

  const get = await fetch(`${BASE}/notes?target_type=error&target_key=${targetKey}`, { headers: auth() });
  const rows = (await get.json()) as Array<{ body: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, "see Jira FLAKEY-42");
});

test("POST /notes rejects an unknown target_type with 400 (allow-list enforcement)", async () => {
  const res = await fetch(`${BASE}/notes`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ target_type: "vulnerability", target_key: "x", body: "note" }),
  });
  assert.equal(res.status, 400, "an unknown target_type must 400 — VALID_TARGET_TYPES is the allow-list");
});

test("GET /notes/counts batches lookups across multiple target_keys", async () => {
  // Three test targets; two get one note each, the third gets none.
  // /counts must report only the two with notes (the third is
  // absent, not present-with-zero).
  const k1 = `count-a-${Date.now()}`;
  const k2 = `count-b-${Date.now()}`;
  const k3 = `count-c-${Date.now()}`;
  await fetch(`${BASE}/notes`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ target_type: "test", target_key: k1, body: "n1" }),
  });
  await fetch(`${BASE}/notes`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ target_type: "test", target_key: k2, body: "n2a" }),
  });
  await fetch(`${BASE}/notes`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ target_type: "test", target_key: k2, body: "n2b" }),
  });

  const res = await fetch(
    `${BASE}/notes/counts?target_type=test&target_keys=${k1},${k2},${k3}`,
    { headers: auth() },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, number>;
  assert.equal(body[k1], 1, "k1 has one note");
  assert.equal(body[k2], 2, "k2 has two notes");
  assert.equal(
    body[k3],
    undefined,
    "k3 has no notes → absent from the result map, not 0 — the UI distinguishes 'no notes' from '0 notes' rendering",
  );
});

// ── /quarantine round-trip + /check ─────────────────────────────────────

test("POST /quarantine + GET /quarantine + DELETE /quarantine round-trip", async () => {
  const suite = `quar-rt-${Date.now()}`;
  const fullTitle = "Login > should reject empty password";

  const post = await fetch(`${BASE}/quarantine`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({
      fullTitle, suiteName: suite, filePath: "login.cy.ts",
      reason: "Intermittent under CI load",
    }),
  });
  assert.equal(post.status, 201);
  const created = (await post.json()) as { quarantined: boolean };
  assert.equal(created.quarantined, true);

  const list = await fetch(`${BASE}/quarantine?suite=${encodeURIComponent(suite)}`, { headers: auth() });
  const rows = (await list.json()) as Array<{ full_title: string; suite_name: string; reason: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].full_title, fullTitle);
  assert.equal(rows[0].reason, "Intermittent under CI load");

  // DELETE expects fullTitle + suiteName in the body.
  const del = await fetch(`${BASE}/quarantine`, {
    method: "DELETE", headers: auth(),
    body: JSON.stringify({ fullTitle, suiteName: suite }),
  });
  assert.equal(del.status, 200);

  // List must be empty after delete.
  const after = await fetch(`${BASE}/quarantine?suite=${encodeURIComponent(suite)}`, { headers: auth() });
  const afterRows = (await after.json()) as unknown[];
  assert.equal(afterRows.length, 0, "delete must remove the row — GET must reflect immediately");
});

test("POST /quarantine on an already-quarantined test upserts (no UNIQUE-violation 500)", async () => {
  const suite = `quar-upsert-${Date.now()}`;
  const fullTitle = "Cart > clearing the cart removes all items";

  const first = await fetch(`${BASE}/quarantine`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ fullTitle, suiteName: suite, reason: "first reason" }),
  });
  assert.equal(first.status, 201);

  // Re-quarantine the same test with a different reason — the
  // route's ON CONFLICT DO UPDATE must rewrite the row, not 500
  // on the unique constraint.
  const second = await fetch(`${BASE}/quarantine`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ fullTitle, suiteName: suite, reason: "updated reason after a closer look" }),
  });
  assert.equal(second.status, 201, "re-quarantine must succeed via the upsert; anything else means the route is non-idempotent");

  const list = await fetch(`${BASE}/quarantine?suite=${encodeURIComponent(suite)}`, { headers: auth() });
  const rows = (await list.json()) as Array<{ full_title: string; reason: string }>;
  assert.equal(rows.length, 1, "still exactly one row after the upsert");
  assert.equal(
    rows[0].reason,
    "updated reason after a closer look",
    "the second POST must overwrite the reason — the upsert SET clause is load-bearing",
  );
});

test("GET /quarantine/check returns the per-suite list for CI integration", async () => {
  // The CI workflow calls /quarantine/check on each shard to get
  // the list of tests it should skip. Test the happy path.
  const suite = `quar-check-${Date.now()}`;
  await fetch(`${BASE}/quarantine`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ fullTitle: "Suite > one", suiteName: suite, filePath: "spec1.cy.ts" }),
  });
  await fetch(`${BASE}/quarantine`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ fullTitle: "Suite > two", suiteName: suite, filePath: "spec2.cy.ts" }),
  });

  const res = await fetch(`${BASE}/quarantine/check?suite=${encodeURIComponent(suite)}`, {
    headers: auth(),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { quarantined: Array<{ full_title: string; file_path: string }> };
  assert.equal(body.quarantined.length, 2, "both quarantined tests must come back");
  const titles = body.quarantined.map((q) => q.full_title).sort();
  assert.deepEqual(titles, ["Suite > one", "Suite > two"]);
});

test("GET /quarantine/check 400s without a suite (CI invocation must always supply one)", async () => {
  const res = await fetch(`${BASE}/quarantine/check`, { headers: auth() });
  assert.equal(res.status, 400, "missing ?suite= must 400 — the CI integration always supplies it");
});

test("POST /quarantine 400s without fullTitle or suiteName", async () => {
  const a = await fetch(`${BASE}/quarantine`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ suiteName: "x" }),
  });
  assert.equal(a.status, 400, "missing fullTitle must 400");

  const b = await fetch(`${BASE}/quarantine`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ fullTitle: "y" }),
  });
  assert.equal(b.status, 400, "missing suiteName must 400");
});
