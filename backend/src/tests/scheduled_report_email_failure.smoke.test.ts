/**
 * Smoke test: a failed EMAIL scheduled report must NOT be marked as sent.
 *
 * Regression guard. deliverEmailReport swallowed sendEmail errors and returned
 * normally, so the caller (sendReportNow / the background sweep) stamped
 * last_sent_at as if delivery succeeded. The dedup SQL is keyed on
 * last_sent_at, so the report would never retry — a never-delivered email
 * report silently marked "sent". The webhook deliverer already throws on
 * non-2xx for exactly this reason; the email deliverer must too.
 *
 * This drives POST /reports/:id/run for an email report against a CLOSED SMTP
 * port (so sendEmail fails with ECONNREFUSED) and asserts the failure surfaces
 * (non-2xx) and last_sent_at stays NULL — i.e. the next tick will retry.
 *
 * Assumes Postgres is up with migrations applied; starts/stops its own server.
 *
 * Run: node --import tsx --test src/tests/scheduled_report_email_failure.smoke.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import type { AddressInfo } from "node:net";

const PORT = 3969;
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

// Bind to an ephemeral port, then immediately release it — nothing will be
// listening there, so an SMTP connection to it fails fast with ECONNREFUSED.
async function aClosedPort(): Promise<number> {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as AddressInfo).port;
  srv.close();
  await once(srv, "close");
  return port;
}

before(async () => {
  const deadSmtpPort = await aClosedPort();
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "smoke-email-fail-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      // Point SMTP at a closed port so every send fails deterministically.
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(deadSmtpPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", () => {}); // swallow: the email failure logs here by design
  await waitForHealth();

  const email = `emailfail+${Date.now()}@test.local`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "testpass123", name: "EmailFail", org_name: "EmailFailOrg" }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text().catch(() => "")}`);
  token = ((await res.json()) as { token: string }).token;
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

test("a failed email run-now surfaces the error and does NOT stamp last_sent_at", async () => {
  const create = await fetch(`${BASE}/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: "Daily email digest",
      cadence: "daily",
      hour_utc: 23,
      channel: "email",
      destination: "ops@test.local",
    }),
  });
  assert.equal(create.status, 201);
  const created = (await create.json()) as { id: number; last_sent_at: string | null };
  assert.equal(created.last_sent_at, null);

  // SMTP is dead → deliverEmailReport must throw → sendReportNow throws before
  // stamping → the route surfaces a 5xx rather than a false { triggered: true }.
  const run = await fetch(`${BASE}/reports/${created.id}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  assert.equal(run.status, 500, "a failed email delivery must surface as an error, not a silent success");

  // The crucial invariant: last_sent_at is still NULL, so the scheduled sweep
  // will retry instead of treating the lost report as already delivered.
  const list = (await (await fetch(`${BASE}/reports`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json()) as Array<{ id: number; last_sent_at: string | null }>;
  const row = list.find((r) => r.id === created.id)!;
  assert.equal(row.last_sent_at, null, "a never-delivered email report must NOT be marked sent");
});
