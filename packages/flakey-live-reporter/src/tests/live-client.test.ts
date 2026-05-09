import { test, mock, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";

import { LiveClient, installShutdownHandler } from "../index.ts";

const URL = "https://api.example.com";
const RUN_ID = 42;
const API_KEY = "fk_test_secret";

const originalFetch = globalThis.fetch;

function makeFetchMock() {
  return mock.fn(async () => new Response("{}", { status: 200 }));
}

beforeEach(() => {
  globalThis.fetch = makeFetchMock() as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("send() queues events with a default timestamp + flush() POSTs them as a single batch", async () => {
  const client = new LiveClient({ url: URL, apiKey: API_KEY, runId: RUN_ID, heartbeatIntervalMs: 0 });
  const before = Date.now();
  client.send({ type: "test.passed", test: "should sign in", spec: "auth.spec.ts" });
  client.send({ type: "test.failed", test: "should reject", spec: "auth.spec.ts", error: "boom" });
  const after = Date.now();

  await client.flush();

  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock.fn>;
  assert.equal(fetchMock.mock.callCount(), 1, "two send()s should batch into a single POST");
  const [callUrl, callOpts] = fetchMock.mock.calls[0].arguments;
  assert.equal(callUrl, `${URL}/live/${RUN_ID}/events`);
  assert.equal(callOpts.method, "POST");
  assert.equal(callOpts.headers["Authorization"], `Bearer ${API_KEY}`);
  assert.equal(callOpts.headers["Content-Type"], "application/json");

  const body = JSON.parse(callOpts.body as string) as Array<{ timestamp: number; type: string }>;
  assert.equal(body.length, 2);
  assert.equal(body[0].type, "test.passed");
  assert.ok(body[0].timestamp >= before && body[0].timestamp <= after,
    "timestamp should be auto-injected within the send window");

  client.stop();
});

test("send() preserves explicit event.timestamp", async () => {
  const client = new LiveClient({ url: URL, apiKey: API_KEY, runId: RUN_ID, heartbeatIntervalMs: 0 });
  client.send({ type: "run.started", timestamp: 1700000000000 });
  await client.flush();

  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock.fn>;
  const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body as string);
  assert.equal(body[0].timestamp, 1700000000000);

  client.stop();
});

test("flush() with empty queue is a no-op (no fetch) by default", async () => {
  const client = new LiveClient({ url: URL, apiKey: API_KEY, runId: RUN_ID, heartbeatIntervalMs: 0 });
  await client.flush();

  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock.fn>;
  assert.equal(fetchMock.mock.callCount(), 0, "empty queue + no allowEmpty → no POST");

  client.stop();
});

test("flush({ allowEmpty: true }) POSTs an empty array (heartbeat path)", async () => {
  const client = new LiveClient({ url: URL, apiKey: API_KEY, runId: RUN_ID, heartbeatIntervalMs: 0 });
  await client.flush({ allowEmpty: true });

  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock.fn>;
  assert.equal(fetchMock.mock.callCount(), 1);
  const body = fetchMock.mock.calls[0].arguments[1].body;
  assert.equal(body, "[]", "heartbeat body should be an empty JSON array");

  client.stop();
});

test("send() schedules a 500ms auto-flush; flush() pre-empts it", async () => {
  const client = new LiveClient({ url: URL, apiKey: API_KEY, runId: RUN_ID, heartbeatIntervalMs: 0 });
  client.send({ type: "test.passed", test: "x" });
  // The auto-flush is scheduled via setTimeout. Calling flush() directly
  // should fire immediately AND clear the pending timer so we don't
  // double-POST.
  await client.flush();
  // Wait long enough for the original 500ms timer to have fired if it
  // wasn't cleared.
  await new Promise((r) => setTimeout(r, 600));

  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock.fn>;
  assert.equal(fetchMock.mock.callCount(), 1, "manual flush() must clear the auto-flush timer");

  client.stop();
});

test("fetch failure is silently swallowed (events are best-effort)", async () => {
  globalThis.fetch = mock.fn(async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;

  const client = new LiveClient({ url: URL, apiKey: API_KEY, runId: RUN_ID, heartbeatIntervalMs: 0 });
  client.send({ type: "test.passed", test: "x" });
  // flush should not reject even though fetch throws.
  await assert.doesNotReject(() => client.flush());

  client.stop();
});

test("abort() POSTs to /live/<id>/abort with the supplied reason + keepalive", async () => {
  const client = new LiveClient({ url: URL, apiKey: API_KEY, runId: RUN_ID, heartbeatIntervalMs: 0 });
  client.abort("e2e: simulated abort");

  // fetch is fire-and-forget; allow the microtask to run.
  await new Promise((r) => setImmediate(r));

  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock.fn>;
  assert.equal(fetchMock.mock.callCount(), 1);
  const [callUrl, callOpts] = fetchMock.mock.calls[0].arguments;
  assert.equal(callUrl, `${URL}/live/${RUN_ID}/abort`);
  assert.equal(callOpts.method, "POST");
  assert.equal(callOpts.keepalive, true);
  assert.deepEqual(JSON.parse(callOpts.body as string), { reason: "e2e: simulated abort" });

  client.stop();
});

test("LiveClient strips a trailing slash from `url` so paths don't double up", async () => {
  const client = new LiveClient({ url: `${URL}/`, apiKey: API_KEY, runId: RUN_ID, heartbeatIntervalMs: 0 });
  client.send({ type: "run.started" });
  await client.flush();

  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock.fn>;
  const callUrl = fetchMock.mock.calls[0].arguments[0];
  assert.equal(callUrl, `${URL}/live/${RUN_ID}/events`,
    "trailing slash on configured URL should not produce //live/...");

  client.stop();
});

test("stop() prevents the heartbeat from firing further fetches", async () => {
  // Use a tight heartbeat so the test doesn't sit 30s.
  const client = new LiveClient({ url: URL, apiKey: API_KEY, runId: RUN_ID, heartbeatIntervalMs: 30 });

  // Allow a beat to fire (or two), then stop.
  await new Promise((r) => setTimeout(r, 80));
  client.stop();

  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock.fn>;
  const beforeStop = fetchMock.mock.callCount();

  // Wait long enough for ≥3 more heartbeats if stop didn't work.
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fetchMock.mock.callCount(), beforeStop, "stop() must cancel further heartbeats");
});

test("installShutdownHandler returns a teardown that prevents subsequent SIGINT-driven aborts", async () => {
  const client = new LiveClient({ url: URL, apiKey: API_KEY, runId: RUN_ID, heartbeatIntervalMs: 0 });
  const teardown = installShutdownHandler(client, { reason: "graceful exit" });

  // Tear down BEFORE any signal — this should remove the handlers.
  teardown();

  // Spy: re-emit SIGINT manually. Since handlers are removed, no fetch.
  // Listening to process.emit on SIGINT is risky in a node:test runner;
  // instead, count current listeners and assert after teardown the
  // SIGINT listener for our handler is gone. We can't easily inspect
  // by reference, but we can check the listener count dropped to its
  // pre-install value.
  const sigintCount = process.listenerCount("SIGINT");
  // Install + immediately tear down a second time to observe parity.
  const t2 = installShutdownHandler(client);
  t2();
  assert.equal(process.listenerCount("SIGINT"), sigintCount,
    "after teardown, the listener count returns to its pre-install state");

  client.stop();
});
