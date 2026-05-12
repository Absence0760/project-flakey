/**
 * GET /live/stream — org-scoped SSE for active-run-set deltas
 * (roadmap Phase 12, replaces the dashboard's /live/active poll).
 *
 * Covered here:
 *   1. The initial `snapshot` event arrives on connect with the
 *      caller's currently-active run ids (empty for a fresh org).
 *   2. POST /live/start delivers an `active.add` delta to a connected
 *      subscriber for the same org.
 *   3. POST /live/:id/abort delivers an `active.remove` delta.
 *   4. Cross-tenant: org B's subscriber never sees org A's deltas.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3962;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let tokenA: string;
let tokenB: string;

async function waitForHealth(maxMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Backend did not become healthy in time");
}

async function registerOrg(label: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `live-stream+${label}+${Date.now()}@test.local`,
      password: "testpass123",
      name: `Live-Stream-${label}`,
      org_name: `LiveStreamOrg-${label}-${Date.now()}`,
    }),
  });
  if (!res.ok) throw new Error(`register ${label} failed: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

/**
 * Open an SSE connection and yield parsed JSON data events. Returns
 * an object holding the abort handle plus an async iterator of events.
 * Comment-only `: ping` lines are filtered out — only `data: <json>`
 * lines are surfaced.
 */
function openStream(token: string): {
  events: AsyncGenerator<unknown, void, void>;
  controller: AbortController;
} {
  const controller = new AbortController();
  const events = (async function* () {
    const res = await fetch(`${BASE}/live/stream?token=${token}`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`/live/stream connect failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        // SSE events are separated by blank lines. Each event may
        // contain `data:` and/or comment lines.
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of raw.split("\n")) {
            if (line.startsWith("data: ")) {
              const payload = line.slice("data: ".length);
              try { yield JSON.parse(payload); } catch { /* skip */ }
            }
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  })();
  return { events, controller };
}

/** Pull the next event from the stream, with a timeout to fail fast. */
async function nextEvent(
  iter: AsyncGenerator<unknown, void, void>,
  maxMs = 5000,
): Promise<unknown> {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`no event within ${maxMs}ms`)), maxMs),
  );
  const next = iter.next().then((r) => {
    if (r.done) throw new Error("stream ended before event arrived");
    return r.value;
  });
  return Promise.race([next, timeout]);
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "live-stream-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      // Long enough that runs created in tests never auto-abort
      // mid-assertion (the stale timer fires at this threshold).
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  tokenA = await registerOrg("a");
  tokenB = await registerOrg("b");
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

test("GET /live/stream sends initial empty snapshot for a fresh org", async () => {
  const { events, controller } = openStream(tokenA);
  try {
    const first = (await nextEvent(events)) as { type: string; runs?: number[] };
    assert.equal(first.type, "snapshot");
    assert.ok(Array.isArray(first.runs), "snapshot must include runs array");
    assert.equal(first.runs!.length, 0, "fresh org has no active runs");
  } finally {
    controller.abort();
  }
});

test("/live/start delivers active.add to a connected subscriber", async () => {
  const { events, controller } = openStream(tokenA);
  try {
    const snapshot = (await nextEvent(events)) as { type: string };
    assert.equal(snapshot.type, "snapshot");

    const startRes = await fetch(`${BASE}/live/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ suite: `stream-add-${Date.now()}` }),
    });
    assert.equal(startRes.status, 201);
    const { id: runId } = (await startRes.json()) as { id: number };

    const delta = (await nextEvent(events)) as { type: string; runId: number };
    assert.equal(delta.type, "active.add");
    assert.equal(delta.runId, runId);

    // Clean up so the run doesn't leak into later tests' active set.
    await fetch(`${BASE}/live/${runId}/abort`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ reason: "test cleanup" }),
    });
  } finally {
    controller.abort();
  }
});

test("/live/:id/abort delivers active.remove to a connected subscriber", async () => {
  // Start the run BEFORE subscribing so the snapshot already lists it.
  const startRes = await fetch(`${BASE}/live/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ suite: `stream-remove-${Date.now()}` }),
  });
  const { id: runId } = (await startRes.json()) as { id: number };

  const { events, controller } = openStream(tokenA);
  try {
    const snapshot = (await nextEvent(events)) as { type: string; runs: number[] };
    assert.equal(snapshot.type, "snapshot");
    assert.ok(snapshot.runs.includes(runId), "snapshot must list the in-flight run");

    await fetch(`${BASE}/live/${runId}/abort`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ reason: "test abort" }),
    });

    const delta = (await nextEvent(events)) as { type: string; runId: number };
    assert.equal(delta.type, "active.remove");
    assert.equal(delta.runId, runId);
  } finally {
    controller.abort();
  }
});

test("/live/stream is org-scoped — org B never sees org A's deltas", async () => {
  // Subscribe as org B, then start a run as org A. Org B's snapshot
  // should be empty AND no active.add delta should arrive within a
  // generous window.
  const { events, controller } = openStream(tokenB);
  try {
    const snapshot = (await nextEvent(events)) as { type: string; runs: number[] };
    assert.equal(snapshot.type, "snapshot");
    assert.equal(snapshot.runs.length, 0, "org B starts with no active runs");

    const startRes = await fetch(`${BASE}/live/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ suite: `cross-tenant-${Date.now()}` }),
    });
    const { id: runId } = (await startRes.json()) as { id: number };

    // No event should arrive on org B's stream. We can't wait forever
    // — race a 1.5 s window. If anything other than a keep-alive ping
    // (already filtered out by openStream) arrives, that's a leak.
    await assert.rejects(
      () => nextEvent(events, 1500),
      /no event within/,
      "org B must NOT receive deltas for org A's run",
    );

    // Cleanup
    await fetch(`${BASE}/live/${runId}/abort`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ reason: "cross-tenant cleanup" }),
    });
  } finally {
    controller.abort();
  }
});
