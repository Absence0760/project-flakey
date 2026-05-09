import { test, mock, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";

import { createApi } from "../api.ts";

/**
 * Unit tests for the MCP server's API helper. Verifies that the helper:
 *   - prefixes the URL correctly (and strips a trailing slash);
 *   - injects the Authorization + Content-Type headers;
 *   - merges caller-supplied headers without dropping the auth one;
 *   - throws on non-2xx with a useful message including a slice of
 *     the response body;
 *   - returns parsed JSON on success.
 */

const URL = "https://api.example.com";
const API_KEY = "fk_test_secret";
const originalFetch = globalThis.fetch;

type Capture = { url: string; opts: any };

function makeFetchMock(
  respond: (url: string, opts: any) => Promise<Response> | Response = async () =>
    new Response("{}", { status: 200 }),
): { fn: ReturnType<typeof mock.fn>; calls: Capture[] } {
  const calls: Capture[] = [];
  const fn = mock.fn(async (url: string, opts: any) => {
    calls.push({ url, opts });
    return respond(url, opts);
  });
  return { fn, calls };
}

let fetchMock: ReturnType<typeof makeFetchMock>;
beforeEach(() => {
  fetchMock = makeFetchMock();
  globalThis.fetch = fetchMock.fn as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("api(path) prefixes URL and injects auth + content-type headers", async () => {
  const api = createApi(URL, API_KEY);
  await api("/runs");

  assert.equal(fetchMock.fn.mock.callCount(), 1);
  const [callUrl, callOpts] = fetchMock.fn.mock.calls[0].arguments;
  assert.equal(callUrl, `${URL}/runs`);
  assert.equal(callOpts.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(callOpts.headers["Content-Type"], "application/json");
});

test("trailing slash on URL is stripped so paths don't double up", async () => {
  const api = createApi(`${URL}/`, API_KEY);
  await api("/runs");
  assert.equal(fetchMock.fn.mock.calls[0].arguments[0], `${URL}/runs`,
    "double-slash URLs would be wrong; stripping must happen in createApi");
});

test("caller-supplied headers merge without overwriting auth", async () => {
  const api = createApi(URL, API_KEY);
  await api("/runs", {
    method: "POST",
    headers: { "X-Custom-Trace-Id": "abc-123" },
    body: JSON.stringify({}),
  });
  const opts = fetchMock.fn.mock.calls[0].arguments[1];
  assert.equal(opts.headers.Authorization, `Bearer ${API_KEY}`,
    "caller headers must NOT remove the auth header");
  assert.equal(opts.headers["X-Custom-Trace-Id"], "abc-123");
  assert.equal(opts.method, "POST");
});

test("non-2xx response throws with status + a slice of the body in the message", async () => {
  fetchMock = makeFetchMock(async () =>
    new Response("internal database error: fk constraint violation on tests.spec_id", {
      status: 500,
    }),
  );
  globalThis.fetch = fetchMock.fn as unknown as typeof fetch;

  const api = createApi(URL, API_KEY);
  await assert.rejects(
    () => api("/runs/9999"),
    (err: Error) => {
      assert.match(err.message, /Flakey API 500/);
      assert.match(err.message, /database error/);
      return true;
    },
  );
});

test("body slice in error message is capped at 200 chars (don't dump huge HTML pages into the model context)", async () => {
  const longBody = "x".repeat(5_000);
  fetchMock = makeFetchMock(async () => new Response(longBody, { status: 502 }));
  globalThis.fetch = fetchMock.fn as unknown as typeof fetch;

  const api = createApi(URL, API_KEY);
  await assert.rejects(
    () => api("/runs"),
    (err: Error) => {
      // "Flakey API 502: " (16 chars) + up to 200 of body = ≤ 216
      assert.ok(err.message.length <= 230, `error message length ${err.message.length} should be capped`);
      return true;
    },
  );
});

test("a 4xx response with an unreadable body still throws cleanly (catch on .text())", async () => {
  fetchMock = makeFetchMock(async () => {
    return new Response(null, { status: 401 }) as any;
  });
  globalThis.fetch = fetchMock.fn as unknown as typeof fetch;

  const api = createApi(URL, API_KEY);
  await assert.rejects(
    () => api("/runs"),
    /Flakey API 401/,
  );
});

test("on 2xx the parsed JSON body is returned to the caller", async () => {
  fetchMock = makeFetchMock(async () =>
    new Response(JSON.stringify({ id: 1, suite: "demo" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  globalThis.fetch = fetchMock.fn as unknown as typeof fetch;

  const api = createApi(URL, API_KEY);
  const out = await api("/runs/1") as { id: number; suite: string };
  assert.deepEqual(out, { id: 1, suite: "demo" });
});
