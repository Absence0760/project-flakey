/**
 * Smoke test for POST /reports/:id/run — the "send a test now" button.
 *
 * Regression guard: the manual dispatch used to re-run the time-gated
 * background sweep (runScheduledReports), so a report whose schedule window
 * hadn't arrived — e.g. a weekly report on a weekday other than today — would
 * be silently skipped while the endpoint still returned { triggered: true }.
 * The fix delivers the specific report immediately, bypassing the window.
 *
 * This test pins that by creating a WEEKLY report on a weekday that is
 * deliberately NOT today (so the old code would have selected nothing) and
 * asserting a webhook POST actually lands at a local sink.
 *
 * Assumes Postgres is up with migrations applied; starts/stops its own server.
 *
 * Run: node --import tsx --test src/tests/scheduled_report_run_now.smoke.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";

const PORT = 3964;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let token: string;

// Local webhook sink — records every request body it receives.
let sink: http.Server;
let sinkUrl: string;
const received: Array<Record<string, unknown>> = [];

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

async function authPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function authGet(path: string): Promise<Response> {
  return fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

async function waitFor<T>(fn: () => T, predicate: (v: T) => boolean, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  let last = fn();
  while (Date.now() - start < timeoutMs) {
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
    last = fn();
  }
  return last;
}

before(async () => {
  sink = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        received.push({ _unparsed: true });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  sink.listen(0);
  await once(sink, "listening");
  const sinkPort = (sink.address() as AddressInfo).port;
  sinkUrl = `http://127.0.0.1:${sinkPort}/hook`;

  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "smoke-test-secret",
      FLAKEY_ENCRYPTION_KEY:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", // gitleaks:allow — deterministic test fixture
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      // Permit the loopback sink as a webhook destination (NODE_ENV=test
      // already disables the SSRF block; set it explicitly for clarity).
      WEBHOOK_ALLOW_PRIVATE_TARGETS: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  const email = `runnow+${Date.now()}@test.local`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "testpass123", name: "RunNow", org_name: "RunNowOrg" }),
  });
  if (!res.ok) {
    throw new Error(`register failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  token = ((await res.json()) as { token: string }).token;
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
  if (sink) {
    sink.close();
    await once(sink, "close").catch(() => {});
  }
});

test("run-now delivers a weekly report scheduled for a different weekday", async () => {
  // Pick a weekday that is definitely NOT today, so the old time-gated path
  // (runScheduledReports requires day_of_week = current UTC day) would have
  // delivered nothing.
  const notToday = (new Date().getUTCDay() + 3) % 7;

  const create = await authPost("/reports", {
    name: "Weekly off-day",
    cadence: "weekly",
    day_of_week: notToday,
    hour_utc: 23,
    channel: "webhook",
    destination: sinkUrl,
  });
  assert.equal(create.status, 201);
  const created = (await create.json()) as { id: number; last_sent_at: string | null };
  assert.equal(created.last_sent_at, null);

  received.length = 0;
  const run = await authPost(`/reports/${created.id}/run`, {});
  assert.equal(run.status, 200);
  assert.deepEqual(await run.json(), { triggered: true });

  // The webhook POST must actually have reached the sink.
  await waitFor(() => received.length, (n) => n >= 1);
  assert.equal(received.length, 1, "expected exactly one webhook delivery");
  assert.equal(received[0].event, "report.summary");
  assert.equal(received[0].cadence, "weekly");

  // last_sent_at must be stamped so the scheduled tick won't re-send.
  const list = (await (await authGet("/reports")).json()) as Array<{
    id: number;
    last_sent_at: string | null;
  }>;
  const row = list.find((r) => r.id === created.id)!;
  assert.ok(row.last_sent_at, "last_sent_at should be set after run-now");
});

test("run-now also works for an inactive report", async () => {
  const create = await authPost("/reports", {
    name: "Paused daily",
    cadence: "daily",
    hour_utc: 23,
    channel: "webhook",
    destination: sinkUrl,
  });
  const created = (await create.json()) as { id: number };
  // Pause it.
  await fetch(`${BASE}/reports/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ active: false }),
  });

  received.length = 0;
  const run = await authPost(`/reports/${created.id}/run`, {});
  assert.equal(run.status, 200);

  await waitFor(() => received.length, (n) => n >= 1);
  assert.equal(received.length, 1, "a paused report should still test-send on demand");
});

test("run-now on a non-existent report id returns 404", async () => {
  const run = await authPost(`/reports/999999/run`, {});
  assert.equal(run.status, 404);
});
