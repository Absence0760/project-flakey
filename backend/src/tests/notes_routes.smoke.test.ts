// Notes routes — targeted smoke coverage for the note-authoring workflow.
//
// routes_reads.smoke.test.ts covers the run-target POST/GET round-trip, and
// notes_and_quarantine.smoke.test.ts covers target_type=test/error plus the
// VALID_TARGET_TYPES allow-list and the basic /counts batching shape. This
// file pins the remaining real-client behaviours of backend/src/routes/notes.ts
// that are otherwise unguarded:
//
//   1. POST /notes trims the body — the route stores body.trim() and returns
//      the trimmed value (both in the POST response and on subsequent GET).
//      A regression that drops the trim leaks leading/trailing whitespace into
//      the note panels.
//   2. GET /notes surfaces user_name + user_email from the users LEFT JOIN so
//      the UI can attribute each note to its author.
//   3. GET /notes/counts only includes keys that actually have notes — absent
//      keys are omitted, NOT present-with-zero. The batched note-count query
//      the UI fires across many runs relies on this to render indicators.
//   4. POST /notes with a whitespace-only body 400s with the documented
//      "Note body is required" message.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3953;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let token: string;
let userName: string;
let userEmail: string;

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
      JWT_SECRET: "notes-routes-test-secret",
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

  userName = "Notes Author";
  userEmail = `notes-routes+${Date.now()}@test.local`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: userEmail,
      password: "testpass123",
      name: userName,
      org_name: `NotesRoutesOrg-${Date.now()}`,
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text().catch(() => "")}`);
  token = ((await reg.json()) as { token: string }).token;
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

// ── body trimming ────────────────────────────────────────────────────────

test("POST /notes trims a whitespace-padded body; GET returns the trimmed text", async () => {
  const targetKey = `trim-target-${Date.now()}`;
  const padded = "   needs a second look   ";
  const trimmed = "needs a second look";

  const post = await fetch(`${BASE}/notes`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ target_type: "test", target_key: targetKey, body: padded }),
  });
  assert.equal(post.status, 201);
  const created = (await post.json()) as { body: string };
  assert.equal(created.body, trimmed, "POST response must echo the trimmed body, not the padded input");

  const get = await fetch(`${BASE}/notes?target_type=test&target_key=${targetKey}`, { headers: auth() });
  assert.equal(get.status, 200);
  const rows = (await get.json()) as Array<{ body: string }>;
  assert.equal(rows.length, 1, "exactly the one note must come back");
  assert.equal(rows[0].body, trimmed, "stored body must be trimmed — no leading/trailing whitespace persisted");
});

// ── author attribution via the users LEFT JOIN ─────────────────────────────

test("GET /notes includes user_name + user_email for the authoring user", async () => {
  const targetKey = `author-target-${Date.now()}`;
  const post = await fetch(`${BASE}/notes`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ target_type: "run", target_key: targetKey, body: "who wrote this" }),
  });
  assert.equal(post.status, 201);

  const get = await fetch(`${BASE}/notes?target_type=run&target_key=${targetKey}`, { headers: auth() });
  assert.equal(get.status, 200);
  const rows = (await get.json()) as Array<{ user_name: string; user_email: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_name, userName, "user_name must come from the users LEFT JOIN");
  assert.equal(rows[0].user_email, userEmail, "user_email must come from the users LEFT JOIN");
});

// ── batched note-count map: present keys only ──────────────────────────────

test("GET /notes/counts returns only keys that have notes (absent keys omitted, not 0)", async () => {
  // The UI batches a note-count lookup across many run targets to draw
  // indicators. A target with zero notes must be ABSENT from the map, not
  // present-with-0 — that's how the UI distinguishes "no notes" from a count.
  const withNotesA = `counts-has-a-${Date.now()}`;
  const withNotesB = `counts-has-b-${Date.now()}`;
  const without = `counts-none-${Date.now()}`;

  await fetch(`${BASE}/notes`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ target_type: "run", target_key: withNotesA, body: "a1" }),
  });
  await fetch(`${BASE}/notes`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ target_type: "run", target_key: withNotesB, body: "b1" }),
  });
  await fetch(`${BASE}/notes`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ target_type: "run", target_key: withNotesB, body: "b2" }),
  });

  // target_keys is a comma-joined query param (see route source).
  const res = await fetch(
    `${BASE}/notes/counts?target_type=run&target_keys=${withNotesA},${withNotesB},${without}`,
    { headers: auth() },
  );
  assert.equal(res.status, 200);
  const counts = (await res.json()) as Record<string, number>;
  assert.equal(counts[withNotesA], 1, "single-note key counts 1");
  assert.equal(counts[withNotesB], 2, "two-note key counts 2");
  assert.equal(
    counts[without],
    undefined,
    "a target with no notes is omitted from the map entirely — not present with 0",
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(counts, without),
    "the empty key must not be a property of the result object at all",
  );
});

// ── empty/whitespace body rejection ────────────────────────────────────────

test("POST /notes with a whitespace-only body 400s with the documented message", async () => {
  const res = await fetch(`${BASE}/notes`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ target_type: "run", target_key: `empty-${Date.now()}`, body: "   " }),
  });
  assert.equal(res.status, 400, "a body that is only whitespace must 400 — body.trim() is empty");
  const data = (await res.json()) as { error: string };
  assert.equal(data.error, "Note body is required");
});
