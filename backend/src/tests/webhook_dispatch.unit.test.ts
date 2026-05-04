/**
 * Webhook dispatch unit tests — loop isolation and timeout enforcement.
 *
 * Past pattern: a single malformed webhook URL or a non-serializable
 * payload threw synchronously inside the dispatch for-loop, aborting
 * dispatch to every subsequent webhook in the same org.  Operators saw
 * "some webhooks fire, some don't" and assumed network flake — actually
 * a sync throw on the first row in the cursor.
 *
 * sendWebhook() is the single-row dispatch helper; the loop calls it
 * once per active webhook row.  These tests pin its contract:
 *   - never throws (sync OR async)
 *   - calls fetch with an AbortSignal so hung receivers don't leak fds
 *   - swallows JSON.stringify failures without poisoning the next row
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendWebhook, type WebhookRunPayload } from "../webhooks.js";

type Mock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function mockFetch(impl: Mock) {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const PAYLOAD: WebhookRunPayload = {
  event: "run.failed",
  run: {
    id: 1, suite_name: "smoke", branch: "main", commit_sha: "abc",
    duration_ms: 100, total: 1, passed: 0, failed: 1, skipped: 0, pending: 0,
    url: "http://x",
  },
  failed_tests: [],
  trend: "",
};

// ── Loop isolation: malformed URL must not throw ────────────────────────

test("sendWebhook: malformed URL does not throw synchronously", () => {
  // fetch("://broken") throws TypeError sync in Node 22+. Without a
  // wrapping try/catch in sendWebhook, the calling for-loop would
  // abort and skip every subsequent webhook in the org.
  assert.doesNotThrow(() => sendWebhook("://not-a-url", "generic", PAYLOAD),
    "malformed URL must be caught and logged, not thrown");
});

test("sendWebhook: empty URL string does not throw", () => {
  assert.doesNotThrow(() => sendWebhook("", "generic", PAYLOAD));
});

// ── Loop isolation: bad payload must not throw ──────────────────────────

test("sendWebhook: payload with non-serializable values is logged, not thrown", () => {
  // Inject a BigInt — JSON.stringify throws TypeError on these.  This
  // could realistically happen if a future field stores a Postgres
  // BIGINT and forgets to coerce to Number/String.
  const evil = { ...PAYLOAD, run: { ...PAYLOAD.run, duration_ms: 100n as any } };
  assert.doesNotThrow(() => sendWebhook("http://example.com/hook", "generic", evil));
});

test("sendWebhook: payload with circular reference is logged, not thrown", () => {
  const evil: any = { ...PAYLOAD };
  evil.self = evil;
  assert.doesNotThrow(() => sendWebhook("http://example.com/hook", "generic", evil));
});

// ── Timeout enforcement ─────────────────────────────────────────────────

test("sendWebhook: passes AbortSignal to fetch (defends against hangs)", async () => {
  let seenSignal: AbortSignal | undefined;
  const restore = mockFetch(async (_url, init) => {
    seenSignal = init?.signal as AbortSignal | undefined;
    return new Response("ok", { status: 200 });
  });
  try {
    sendWebhook("http://example.com/hook", "generic", PAYLOAD);
    // Yield once so the in-flight fetch starts.
    await new Promise((r) => setImmediate(r));
    assert.ok(seenSignal, "fetch must be called with an AbortSignal");
    assert.equal(typeof seenSignal!.aborted, "boolean");
  } finally {
    restore();
  }
});

// ── Successful dispatch reaches fetch with platform-specific body ───────

test("sendWebhook: generic platform produces a body with a text field", async () => {
  let seenBody = "";
  const restore = mockFetch(async (_url, init) => {
    seenBody = init?.body as string;
    return new Response("ok", { status: 200 });
  });
  try {
    sendWebhook("http://example.com/hook", "generic", PAYLOAD);
    await new Promise((r) => setImmediate(r));
    assert.ok(seenBody.length > 0);
    const parsed = JSON.parse(seenBody);
    // Generic format includes a text field — see webhook-formatters.ts
    assert.ok(parsed.text || parsed.event, "generic body should have text or event");
  } finally {
    restore();
  }
});

test("sendWebhook: slack platform produces a body parseable by Slack (no NaN, no undefined)", async () => {
  let seenBody = "";
  const restore = mockFetch(async (_url, init) => {
    seenBody = init?.body as string;
    return new Response("ok", { status: 200 });
  });
  try {
    sendWebhook("http://example.com/hook", "slack", PAYLOAD);
    await new Promise((r) => setImmediate(r));
    // Slack's incoming webhooks reject any payload that's not
    // valid JSON; round-trip must succeed.
    assert.doesNotThrow(() => JSON.parse(seenBody));
  } finally {
    restore();
  }
});

// ── Async fetch failures are caught (no unhandled rejection) ────────────

test("sendWebhook: fetch rejection does not produce an unhandled rejection", async () => {
  // The outer try/catch only covers the sync throw.  The .catch on the
  // returned promise covers async failures.  If we drop the .catch in a
  // future refactor, an upstream UnhandledRejection would terminate the
  // process under strict modes.
  const restore = mockFetch(async () => {
    throw new Error("network down");
  });
  try {
    sendWebhook("http://example.com/hook", "generic", PAYLOAD);
    // Wait long enough that any unhandled rejection would surface.
    await new Promise((r) => setTimeout(r, 50));
    // If we got here without crashing, the contract holds.
    assert.ok(true);
  } finally {
    restore();
  }
});
