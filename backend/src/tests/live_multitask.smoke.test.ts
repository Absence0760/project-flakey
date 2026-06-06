/**
 * Cross-task live fan-out via Postgres LISTEN/NOTIFY.
 *
 * The live bus is in-process, so once ECS runs more than one task a
 * reporter POSTing events to task A would never reach an SSE client
 * parked on task B. F7 fixes that: every task LISTENs on a Postgres
 * channel and re-emits remote NOTIFYs to its own subscribers.
 *
 * This spec spins up TWO server processes pointed at the SAME database
 * (sharing JWT_SECRET so a token minted on A is valid on B) and proves:
 *   1. A per-run event POSTed to task A is delivered to a /live/:id/stream
 *      subscriber connected to task B.
 *   2. An active-set delta (active.add on /live/start, active.remove on
 *      abort) raised on task A reaches a /live/stream subscriber on task B.
 *   3. The DB-authoritative snapshot on task B lists a run that was
 *      started on task A (no shared in-memory state required).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT_A = 3969;
const PORT_B = 3970;
const BASE_A = `http://localhost:${PORT_A}`;
const BASE_B = `http://localhost:${PORT_B}`;
// Shared so a token minted on A authenticates on B, and both LISTEN on the
// same database's channel.
const JWT_SECRET = "live-multitask-test-secret";

let serverA: ChildProcess;
let serverB: ChildProcess;
let token: string;

function spawnServer(port: number): ChildProcess {
  const proc = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET,
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      // Long enough that runs created here never auto-abort mid-assertion.
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", () => {});
  proc.stderr?.on("data", (d) => process.stderr.write(d));
  return proc;
}

async function waitForHealth(base: string, maxMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Backend at ${base} did not become healthy in time`);
}

/** Open an SSE connection and yield parsed `data:` JSON events. */
function openStream(base: string, path: string, token: string): {
  events: AsyncGenerator<unknown, void, void>;
  controller: AbortController;
} {
  const controller = new AbortController();
  const sep = path.includes("?") ? "&" : "?";
  const events = (async function* () {
    const res = await fetch(`${base}${path}${sep}token=${token}`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`${path} connect failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of raw.split("\n")) {
            if (line.startsWith("data: ")) {
              try { yield JSON.parse(line.slice("data: ".length)); } catch { /* skip */ }
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

/** Pull events until `predicate` matches, or throw on timeout. */
async function waitFor(
  iter: AsyncGenerator<unknown, void, void>,
  predicate: (e: any) => boolean,
  maxMs = 6000,
): Promise<any> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`no matching event within ${maxMs}ms`)), maxMs),
  );
  const find = (async () => {
    for (;;) {
      const r = await iter.next();
      if (r.done) throw new Error("stream ended before a matching event arrived");
      if (predicate(r.value)) return r.value;
    }
  })();
  return Promise.race([find, timeout]);
}

function authPost(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

before(async () => {
  serverA = spawnServer(PORT_A);
  serverB = spawnServer(PORT_B);
  await Promise.all([waitForHealth(BASE_A), waitForHealth(BASE_B)]);

  const reg = await fetch(`${BASE_A}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `multitask+${Date.now()}@test.local`,
      password: "testpass123",
      name: "Multitask",
      org_name: `MultitaskOrg-${Date.now()}`,
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
  token = ((await reg.json()) as { token: string }).token;
});

after(async () => {
  for (const s of [serverA, serverB]) {
    if (s && !s.killed) {
      s.kill("SIGTERM");
      await once(s, "exit").catch(() => {});
    }
  }
});

test("a per-run event POSTed to task A reaches a /live/:id/stream subscriber on task B", async () => {
  // Start the run on A.
  const startRes = await authPost(BASE_A, "/live/start", { suite: `multitask-evt-${Date.now()}` });
  assert.equal(startRes.status, 201);
  const { id: runId } = (await startRes.json()) as { id: number };

  // Subscribe to the per-run stream on B and wait for the connect frame so
  // B's emitter + subscriber are attached before A emits.
  const { events, controller } = openStream(BASE_B, `/live/${runId}/stream`, token);
  try {
    await waitFor(events, (e) => e.type === "connected");

    // POST a test event to A. It must cross to B via NOTIFY.
    const marker = `cross-task-${Date.now()}`;
    const evRes = await authPost(BASE_A, `/live/${runId}/events`, {
      type: "test.passed", test: marker, status: "passed",
    });
    assert.equal(evRes.status, 200);

    const delivered = await waitFor(events, (e) => e.type === "test.passed" && e.test === marker);
    assert.equal(delivered.runId, runId, "delivered event must carry the run id");
  } finally {
    controller.abort();
    await authPost(BASE_A, `/live/${runId}/abort`, { reason: "evt test cleanup" });
  }
});

test("active.add / active.remove raised on task A reach a /live/stream subscriber on task B", async () => {
  const { events, controller } = openStream(BASE_B, "/live/stream", token);
  try {
    // Drain the initial snapshot.
    await waitFor(events, (e) => e.type === "snapshot");

    const startRes = await authPost(BASE_A, "/live/start", { suite: `multitask-active-${Date.now()}` });
    assert.equal(startRes.status, 201);
    const { id: runId } = (await startRes.json()) as { id: number };

    const add = await waitFor(events, (e) => e.type === "active.add" && e.runId === runId);
    assert.equal(add.runId, runId);

    await authPost(BASE_A, `/live/${runId}/abort`, { reason: "active test abort" });
    const remove = await waitFor(events, (e) => e.type === "active.remove" && e.runId === runId);
    assert.equal(remove.runId, runId);
  } finally {
    controller.abort();
  }
});

test("task B's /live/stream snapshot lists a run started on task A (DB-authoritative)", async () => {
  // Start on A, then connect a fresh /live/stream on B — the snapshot must
  // already include the run even though no delta was delivered to B yet.
  const startRes = await authPost(BASE_A, "/live/start", { suite: `multitask-snap-${Date.now()}` });
  const { id: runId } = (await startRes.json()) as { id: number };

  const { events, controller } = openStream(BASE_B, "/live/stream", token);
  try {
    const snapshot = await waitFor(events, (e) => e.type === "snapshot");
    assert.ok(
      Array.isArray(snapshot.runs) && snapshot.runs.includes(runId),
      "B's snapshot must list the run started on A",
    );
  } finally {
    controller.abort();
    await authPost(BASE_A, `/live/${runId}/abort`, { reason: "snap test cleanup" });
  }
});
