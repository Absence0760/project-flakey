import { test, mock, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";

import { LiveClient, installShutdownHandler } from "../index.ts";
import type { LiveEvent } from "../index.ts";

type LiveEventType = LiveEvent["type"];

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

test("a burst of send()s flushes in emit order with nothing lost or reordered", async () => {
  const client = new LiveClient({ url: URL, apiKey: API_KEY, runId: RUN_ID, heartbeatIntervalMs: 0 });

  const types: LiveEventType[] = [
    "run.started",
    "spec.started",
    "test.started",
    "test.passed",
    "test.started",
    "test.failed",
    "test.started",
    "test.skipped",
    "spec.finished",
    "run.finished",
  ];
  for (let i = 0; i < types.length; i++) {
    client.send({ type: types[i], test: `t${i}` });
  }

  await client.flush();

  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock.fn>;
  assert.equal(fetchMock.mock.callCount(), 1, "a single flush delivers the whole burst in one POST");
  const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body as string) as Array<{ type: string; test?: string }>;
  assert.equal(body.length, types.length, "no events dropped from the batch");
  // Order must be exactly the emit order — no reordering across the batch.
  assert.deepEqual(body.map((e) => e.type), types, "events flushed in the exact order they were sent");
  assert.deepEqual(body.map((e) => e.test), types.map((_, i) => `t${i}`), "per-event payload preserved + ordered");

  client.stop();
});

test("queue resets after a successful flush; the next send() reschedules a fresh auto-flush", async () => {
  const client = new LiveClient({ url: URL, apiKey: API_KEY, runId: RUN_ID, heartbeatIntervalMs: 0 });

  client.send({ type: "test.passed", test: "first" });
  await client.flush();

  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock.fn>;
  assert.equal(fetchMock.mock.callCount(), 1);

  // A second flush with nothing new queued must NOT re-POST the first batch —
  // proves the queue was drained, not merely copied.
  await client.flush();
  assert.equal(fetchMock.mock.callCount(), 1, "drained queue → no duplicate POST of already-sent events");

  // After a drain the auto-flush timer was cleared. A fresh send() must
  // reschedule its own 500ms timer and deliver the new event on its own.
  client.send({ type: "test.failed", test: "second" });
  await new Promise((r) => setTimeout(r, 600));

  assert.equal(fetchMock.mock.callCount(), 2, "post-drain send() reschedules and auto-flushes");
  const secondBody = JSON.parse(fetchMock.mock.calls[1].arguments[1].body as string) as Array<{ test?: string }>;
  assert.equal(secondBody.length, 1, "second batch only contains events sent after the drain");
  assert.equal(secondBody[0].test, "second");

  client.stop();
});

test("send() during an in-flight flush is retained for the next batch, not dropped", async () => {
  // Gate the in-flight fetch so we can interleave a send() before it resolves.
  let releaseFetch: () => void = () => {};
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const fetchMock = mock.fn(async () => {
    await fetchGate;
    return new Response("{}", { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const client = new LiveClient({ url: URL, apiKey: API_KEY, runId: RUN_ID, heartbeatIntervalMs: 0 });

  client.send({ type: "test.passed", test: "in-flight-1" });
  const firstFlush = client.flush(); // splices the queue, then awaits the gated fetch

  // While that fetch is still pending, the runner emits another event.
  client.send({ type: "test.failed", test: "arrived-mid-flush" });

  // Release the in-flight fetch and let the first flush settle.
  releaseFetch();
  await firstFlush;

  assert.equal(fetchMock.mock.callCount(), 1, "only the first batch has gone out so far");
  const firstBody = JSON.parse(fetchMock.mock.calls[0].arguments[1].body as string) as Array<{ test?: string }>;
  assert.deepEqual(firstBody.map((e) => e.test), ["in-flight-1"], "first batch holds only the pre-flush event");

  // The event sent mid-flush must still be queued — flush it now.
  await client.flush();
  assert.equal(fetchMock.mock.callCount(), 2, "the mid-flush event triggers its own batch");
  const secondBody = JSON.parse(fetchMock.mock.calls[1].arguments[1].body as string) as Array<{ test?: string }>;
  assert.deepEqual(secondBody.map((e) => e.test), ["arrived-mid-flush"],
    "event emitted during an in-flight flush is delivered in the next batch — not lost");

  client.stop();
});

test("a 5xx response does not reject flush(); the run continues but the batch is dropped (best-effort, no retry)", async () => {
  const fetchMock = mock.fn(async () => new Response("upstream boom", { status: 503 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const client = new LiveClient({ url: URL, apiKey: API_KEY, runId: RUN_ID, heartbeatIntervalMs: 0 });
  client.send({ type: "test.passed", test: "x" });

  // fetch resolves (5xx is not a thrown error), so flush must not reject.
  await assert.doesNotReject(() => client.flush(), "a 5xx response must not crash the run");
  assert.equal(fetchMock.mock.callCount(), 1);

  // Contract check: the source `splice(0)`s the queue BEFORE the request and
  // never re-enqueues on a non-2xx response, so a failed flush silently
  // discards that batch with no retry. A subsequent flush has nothing to send.
  await client.flush();
  assert.equal(fetchMock.mock.callCount(), 1,
    "no automatic retry — the 5xx batch is gone, not re-sent on the next flush");

  client.stop();
});

test("a mid-flush abort (fetch throws AbortError) is swallowed and the dropped batch is not retried", async () => {
  const fetchMock = mock.fn(async () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const client = new LiveClient({ url: URL, apiKey: API_KEY, runId: RUN_ID, heartbeatIntervalMs: 0 });
  client.send({ type: "test.passed", test: "aborted-batch" });

  await assert.doesNotReject(() => client.flush(), "an aborted request must not crash the run");
  assert.equal(fetchMock.mock.callCount(), 1);

  // The batch was spliced out before the throw, so it's lost — nothing to resend.
  await client.flush();
  assert.equal(fetchMock.mock.callCount(), 1, "the aborted batch is dropped, not retried");

  client.stop();
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
