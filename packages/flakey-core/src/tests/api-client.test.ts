import { test, mock, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { ApiClient } from "../api-client.ts";
import type { NormalizedRun } from "../schema.ts";

const fixtureRun: NormalizedRun = {
  meta: {
    suite_name: "smoke",
    branch: "main",
    commit_sha: "deadbeef",
    ci_run_id: "ci-1",
    started_at: "2026-05-08T00:00:00Z",
    finished_at: "2026-05-08T00:00:01Z",
    reporter: "test-fixture",
  },
  stats: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0, duration_ms: 1000 },
  specs: [],
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mock.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("postRun targets <url>/runs with bearer auth + JSON body", async () => {
  const fetchMock = globalThis.fetch as ReturnType<typeof mock.fn>;
  fetchMock.mock.mockImplementation(async () =>
    new Response(JSON.stringify({ id: 42 }), { status: 200 })
  );

  const client = new ApiClient({
    url: "http://localhost:3000",
    apiKey: "k_test",
    suite: "smoke",
  });
  const result = await client.postRun(fixtureRun);

  assert.equal(result.id, 42);
  assert.equal(fetchMock.mock.calls.length, 1);

  const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, "http://localhost:3000/runs");
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer k_test",
  });
  assert.deepEqual(JSON.parse(init.body as string), fixtureRun);
});

test("postRun strips a trailing slash from the configured URL", async () => {
  const fetchMock = globalThis.fetch as ReturnType<typeof mock.fn>;
  fetchMock.mock.mockImplementation(async () =>
    new Response(JSON.stringify({ id: 1 }), { status: 200 })
  );

  const client = new ApiClient({ url: "https://api.example.com/", apiKey: "k", suite: "s" });
  await client.postRun(fixtureRun);

  const [url] = fetchMock.mock.calls[0].arguments as [string];
  assert.equal(url, "https://api.example.com/runs");
});

test("postRun throws with status + body text on non-2xx", async () => {
  const fetchMock = globalThis.fetch as ReturnType<typeof mock.fn>;
  fetchMock.mock.mockImplementation(async () =>
    new Response("rate limited", { status: 429 })
  );

  const client = new ApiClient({ url: "http://localhost:3000", apiKey: "k", suite: "s" });
  await assert.rejects(
    () => client.postRun(fixtureRun),
    /Flakey API error 429: rate limited/
  );
});

test("postRunWithFiles falls back to postRun when no files are present", async () => {
  const fetchMock = globalThis.fetch as ReturnType<typeof mock.fn>;
  fetchMock.mock.mockImplementation(async () =>
    new Response(JSON.stringify({ id: 7 }), { status: 200 })
  );

  const client = new ApiClient({ url: "http://localhost:3000", apiKey: "k", suite: "s" });
  await client.postRunWithFiles(fixtureRun, { screenshots: [], videos: [], snapshots: [] });

  const [url] = fetchMock.mock.calls[0].arguments as [string];
  assert.equal(url, "http://localhost:3000/runs");
});

test("postRunWithFiles falls back to postRun when every listed file is missing on disk", async () => {
  const fetchMock = globalThis.fetch as ReturnType<typeof mock.fn>;
  fetchMock.mock.mockImplementation(async () =>
    new Response(JSON.stringify({ id: 9 }), { status: 200 })
  );

  const client = new ApiClient({ url: "http://localhost:3000", apiKey: "k", suite: "s" });
  await client.postRunWithFiles(fixtureRun, {
    screenshots: ["/nope/missing-1.png"],
    videos: ["/nope/missing-2.mp4"],
    snapshots: ["/nope/missing-3.gz"],
  });

  assert.equal(fetchMock.mock.calls.length, 1);
  const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, "http://localhost:3000/runs");
  // JSON path, not multipart — body is the serialized run, not FormData.
  assert.deepEqual(JSON.parse(init.body as string), fixtureRun);
});
