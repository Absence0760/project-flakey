// End-to-end webhook dispatch smoke.
//
// webhook_dispatch.unit.test.ts covers sendWebhook's safety
// (malformed URL, circular payload, AbortSignal). webhook_formatters
// .unit.test.ts covers the per-platform body shapes. Neither
// exercises the trigger path: a /runs/upload that includes failures
// must cause the backend to actually POST to the configured webhook
// URL — and only to the ones whose `events` column lists the matching
// event.
//
// This file spins up a one-off node:http receiver inside the test
// process, points a configured webhook at it, uploads runs of
// varying pass/fail shapes, and asserts the receiver got the right
// POSTs with the right event names. The same shape (one webhook, one
// receiver, dispatch through the real route) is what real customers
// hit; a regression in the dispatch trigger or the event-filter
// query slips past the unit tests and just stops paging on-call.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import http, { type Server } from "node:http";

const BACKEND_PORT = 3975;
const RECEIVER_PORT = 3901;
const BASE = `http://localhost:${BACKEND_PORT}`;
const RECEIVER_URL = `http://localhost:${RECEIVER_PORT}/hook`;

let server: ChildProcess;
let receiver: Server;
let token: string;

// In-memory captured POSTs, oldest first. Cleared between tests by
// resetReceived() so each scenario can assert in isolation.
type Received = { event: string; body: Record<string, unknown> };
let received: Received[] = [];
function resetReceived(): void {
  received = [];
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

async function startReceiver(): Promise<void> {
  receiver = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const event = typeof parsed.event === "string" ? parsed.event : "unknown";
        received.push({ event, body: parsed });
      } catch {
        // Non-JSON body — record it as 'invalid' so a regression
        // that sends garbage isn't silently swallowed.
        received.push({ event: "invalid-json", body: { raw: body } });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(RECEIVER_PORT, resolve));
}

async function stopReceiver(): Promise<void> {
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
}

async function configureWebhook(events: string[]): Promise<number> {
  const res = await fetch(`${BASE}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: "e2e-test-receiver",
      url: RECEIVER_URL,
      events,
      platform: "generic",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`POST /webhooks failed: ${res.status} ${body}`);
  }
  return ((await res.json()) as { id: number }).id;
}

async function deleteWebhook(id: number): Promise<void> {
  await fetch(`${BASE}/webhooks/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

async function uploadRun(opts: {
  suite: string; passed: number; failed: number;
}): Promise<number> {
  const total = opts.passed + opts.failed;
  const tests = [
    ...Array.from({ length: opts.passed }, (_, i) => ({
      title: `pass-${i}`, full_title: `pass-${i}`, status: "passed",
      duration_ms: 10, screenshot_paths: [],
    })),
    ...Array.from({ length: opts.failed }, (_, i) => ({
      title: `fail-${i}`, full_title: `fail-${i}`, status: "failed",
      duration_ms: 10, error: { message: "boom" }, screenshot_paths: [],
    })),
  ];
  const fd = new FormData();
  fd.append("payload", JSON.stringify({
    meta: {
      suite_name: opts.suite,
      branch: "main",
      commit_sha: `sha-${opts.suite}`,
      ci_run_id: `ci-${opts.suite}-${Date.now()}`,
      started_at: "2026-05-10T00:00:00Z",
      finished_at: "2026-05-10T00:00:10Z",
      reporter: "mochawesome",
    },
    stats: { total, passed: opts.passed, failed: opts.failed, skipped: 0, pending: 0, duration_ms: 10000 },
    specs: [{
      file_path: `${opts.suite}.cy.ts`,
      title: opts.suite,
      stats: { total, passed: opts.passed, failed: opts.failed, skipped: 0, duration_ms: 10000 },
      tests,
    }],
  }));
  const res = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`/runs/upload failed: ${res.status} ${body}`);
  }
  return ((await res.json()) as { id: number }).id;
}

// Wait up to `maxMs` for `predicate` to become true. Webhook
// dispatch is fire-and-forget after the upload response, so the
// test must poll the receiver rather than awaiting the upload.
async function waitFor(predicate: () => boolean, maxMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

before(async () => {
  await startReceiver();
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(BACKEND_PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "webhook-e2e-test-secret",
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
      email: `webhook-e2e+${Date.now()}@test.local`,
      password: "testpass123",
      name: "Webhook E2E",
      org_name: `WebhookE2EOrg-${Date.now()}`,
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
  await stopReceiver();
});

// ── 1. run.failed fires when a failing run is uploaded ─────────────────

test("uploading a failing run dispatches run.failed to a webhook subscribed to that event", async () => {
  resetReceived();
  const id = await configureWebhook(["run.failed"]);
  try {
    await uploadRun({ suite: `fail-suite-${Date.now()}`, passed: 1, failed: 2 });

    await waitFor(() => received.some((r) => r.event === "run.failed"));
    const failedEvents = received.filter((r) => r.event === "run.failed");
    assert.equal(failedEvents.length, 1, "exactly one run.failed POST must arrive at the receiver");

    const body = failedEvents[0].body as {
      event: string; run?: { failed?: number; total?: number; url?: string };
      failed_tests?: Array<{ full_title: string; error_message: string | null; spec_file: string }>;
    };
    assert.equal(body.event, "run.failed");
    assert.equal(body.run?.failed, 2, "payload's run.failed count must reflect the uploaded run");
    assert.equal(body.run?.total, 3, "payload's run.total must reflect total tests across pass+fail");
    assert.ok(body.run?.url?.includes("/runs/"), "payload must include the dashboard run URL");
    assert.ok(
      body.failed_tests && body.failed_tests.length === 2,
      "failed_tests must list every failing test in the run (capped at 10)",
    );
    assert.equal(body.failed_tests[0].error_message, "boom", "error_message must round-trip into the payload");
  } finally {
    await deleteWebhook(id);
  }
});

// ── 2. run.completed always fires (even for all-passing runs) ──────────

test("uploading any run dispatches run.completed; a webhook subscribed only to run.completed gets one POST", async () => {
  resetReceived();
  const id = await configureWebhook(["run.completed"]);
  try {
    // All-passing run: run.completed should still fire.
    await uploadRun({ suite: `complete-suite-${Date.now()}`, passed: 3, failed: 0 });

    await waitFor(() => received.some((r) => r.event === "run.completed"));
    const events = received.filter((r) => r.event === "run.completed");
    assert.equal(events.length, 1, "run.completed must fire for any run, including all-passing");

    // The webhook is NOT subscribed to run.failed — no run.failed
    // event should appear in this receiver even though the upload
    // is all-passing (so run.failed wouldn't fire anyway, but the
    // filter is the load-bearing check).
    assert.ok(
      !received.some((r) => r.event === "run.failed"),
      "a webhook subscribed only to run.completed must NOT receive run.failed events",
    );
  } finally {
    await deleteWebhook(id);
  }
});

// ── 3. Event-filter: webhook NOT subscribed to run.failed stays silent ─

test("a webhook subscribed only to run.passed receives nothing when a failing run is uploaded", async () => {
  resetReceived();
  // Webhook subscribed only to run.passed.  Uploading a failing
  // run must NOT trigger a POST — the SQL filter (events column
  // ANY operator) must respect the subscription.
  const id = await configureWebhook(["run.passed"]);
  try {
    await uploadRun({ suite: `mismatch-suite-${Date.now()}`, passed: 0, failed: 3 });

    // Give the dispatch a fair window to fire (or not).
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(
      received.length,
      0,
      `webhook subscribed only to run.passed must NOT receive POSTs from a failing run; got ${received.length}: ${received.map((r) => r.event).join(", ")}`,
    );
  } finally {
    await deleteWebhook(id);
  }
});

// ── 4. Multi-event subscription: one upload produces both events ───────

test("a webhook subscribed to both run.failed AND run.completed receives both POSTs for a failing upload", async () => {
  resetReceived();
  const id = await configureWebhook(["run.failed", "run.completed"]);
  try {
    await uploadRun({ suite: `multi-event-${Date.now()}`, passed: 0, failed: 1 });

    await waitFor(() =>
      received.some((r) => r.event === "run.failed") &&
      received.some((r) => r.event === "run.completed"),
    );
    const eventNames = received.map((r) => r.event).sort();
    assert.deepEqual(
      eventNames,
      ["run.completed", "run.failed"],
      "a failing upload to a webhook subscribed to both events must produce exactly one of each (run.completed always, run.failed because failed > 0)",
    );
  } finally {
    await deleteWebhook(id);
  }
});

// ── 5. Inactive webhook is silent ──────────────────────────────────────

test("a webhook with active=false does not receive POSTs", async () => {
  resetReceived();
  const id = await configureWebhook(["run.failed"]);
  try {
    // PATCH the webhook to inactive.
    const patch = await fetch(`${BASE}/webhooks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ active: false }),
    });
    assert.ok(patch.ok, `PATCH /webhooks/${id} should succeed; got ${patch.status}`);

    await uploadRun({ suite: `inactive-suite-${Date.now()}`, passed: 0, failed: 1 });
    await new Promise((r) => setTimeout(r, 1000));

    assert.equal(
      received.length,
      0,
      "an inactive webhook must NOT receive POSTs — the SELECT filter on `active = true` is load-bearing for the pause-without-deleting UX",
    );
  } finally {
    await deleteWebhook(id);
  }
});

// ── 6. GET /webhooks/events is the single source of truth for the picker ─

// The frontend's event-selection UI used to hardcode the event list,
// which could silently drift from the dispatcher's VALID_EVENTS. The
// endpoint now serves the list so the picker can't drift. The set it
// returns must therefore exactly match every event the dispatch path
// can actually emit — anything missing is unselectable, anything extra
// is a dead option. The dispatchable events are the union of the
// per-event scenarios above; assert the endpoint covers them with
// non-empty friendly labels.
test("GET /webhooks/events returns every dispatchable event with a friendly label", async () => {
  const res = await fetch(`${BASE}/webhooks/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.ok(res.ok, `GET /webhooks/events should succeed; got ${res.status}`);
  const body = (await res.json()) as { events: Array<{ event: string; label: string }> };

  assert.ok(Array.isArray(body.events) && body.events.length > 0, "events must be a non-empty array");

  // Every entry pairs a non-empty event key with a non-empty label.
  for (const e of body.events) {
    assert.ok(typeof e.event === "string" && e.event.length > 0, "each entry must carry an event key");
    assert.ok(typeof e.label === "string" && e.label.trim().length > 0, `event ${e.event} must carry a non-empty label`);
  }

  // The list must cover every event the dispatcher actually emits.
  // These are the exact events the scenarios above prove are dispatched
  // plus the flaky-alert events; keep this in lockstep with the
  // dispatcher's VALID_EVENTS.
  const returned = new Set(body.events.map((e) => e.event));
  const dispatchable = [
    "run.failed", "run.passed", "run.completed",
    "new.failures", "flaky.detected", "flaky.threshold.exceeded",
  ];
  for (const ev of dispatchable) {
    assert.ok(returned.has(ev), `GET /webhooks/events must include dispatchable event '${ev}'`);
  }

  // Spot-check the friendly wording for the two events whose labels
  // aren't a trivial title-case of the key.
  const byEvent = new Map(body.events.map((e) => [e.event, e.label]));
  assert.equal(byEvent.get("run.failed"), "Run failed");
  assert.equal(byEvent.get("flaky.threshold.exceeded"), "Flaky rate threshold exceeded");
});
