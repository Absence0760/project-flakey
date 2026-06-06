import { test, mock, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// --- multipart upload path (files present on disk) ---

let tmp: string;

function writeFixture(name: string, bytes = "x"): string {
  const p = join(tmp, name);
  writeFileSync(p, bytes);
  return p;
}

// Extract the parsed FormData from the most recent fetch mock call.
async function uploadedFormData(
  fetchMock: ReturnType<typeof mock.fn>
): Promise<{ url: string; init: RequestInit; form: FormData }> {
  const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
  // Round-trip the FormData body through a Request so we can inspect parts
  // exactly as the server would (preserves filenames + blob MIME types).
  const form = await new Request("http://x/", {
    method: "POST",
    body: init.body as BodyInit,
  }).formData();
  return { url, init, form };
}

test("postRunWithFiles POSTs multipart to /runs/upload when files exist on disk", async () => {
  tmp = mkdtempSync(join(tmpdir(), "flakey-upload-"));
  try {
    const fetchMock = globalThis.fetch as ReturnType<typeof mock.fn>;
    fetchMock.mock.mockImplementation(async () =>
      new Response(JSON.stringify({ id: 101 }), { status: 200 })
    );

    const shot = writeFixture("shot.png");
    const client = new ApiClient({ url: "http://localhost:3000", apiKey: "k_up", suite: "s" });
    const result = await client.postRunWithFiles(fixtureRun, {
      screenshots: [shot],
      videos: [],
      snapshots: [],
    });

    assert.equal(result.id, 101);
    const { url, init, form } = await uploadedFormData(fetchMock);

    assert.equal(url, "http://localhost:3000/runs/upload");
    assert.equal(init.method, "POST");
    // FormData owns the multipart boundary — the client must NOT set Content-Type.
    assert.deepEqual(init.headers, { Authorization: "Bearer k_up" });

    // The run payload rides as a JSON part named "payload".
    assert.deepEqual(JSON.parse(form.get("payload") as string), fixtureRun);

    const file = form.get("screenshots") as File;
    assert.equal(file.name, "shot.png");
    assert.equal(file.type, "image/png");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("postRunWithFiles sets MIME by extension for videos and snapshots", async () => {
  tmp = mkdtempSync(join(tmpdir(), "flakey-upload-"));
  try {
    const fetchMock = globalThis.fetch as ReturnType<typeof mock.fn>;
    fetchMock.mock.mockImplementation(async () =>
      new Response(JSON.stringify({ id: 102 }), { status: 200 })
    );

    const webm = writeFixture("clip.webm");
    const mp4 = writeFixture("clip.mp4");
    const snap = writeFixture("dom.snap.gz");

    const client = new ApiClient({ url: "http://localhost:3000", apiKey: "k", suite: "s" });
    await client.postRunWithFiles(fixtureRun, {
      screenshots: [],
      videos: [webm, mp4],
      snapshots: [snap],
    });

    const { url, form } = await uploadedFormData(fetchMock);
    assert.equal(url, "http://localhost:3000/runs/upload");

    const videos = form.getAll("videos") as File[];
    assert.equal(videos.length, 2);
    const byName = Object.fromEntries(videos.map((v) => [v.name, v.type]));
    assert.equal(byName["clip.webm"], "video/webm");
    assert.equal(byName["clip.mp4"], "video/mp4");

    const snapshot = form.get("snapshots") as File;
    assert.equal(snapshot.name, "dom.snap.gz");
    assert.equal(snapshot.type, "application/gzip");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("postRunWithFiles drops missing files but keeps the ones present on disk", async () => {
  tmp = mkdtempSync(join(tmpdir(), "flakey-upload-"));
  try {
    const fetchMock = globalThis.fetch as ReturnType<typeof mock.fn>;
    fetchMock.mock.mockImplementation(async () =>
      new Response(JSON.stringify({ id: 103 }), { status: 200 })
    );

    const present = writeFixture("present.png");
    const client = new ApiClient({ url: "http://localhost:3000", apiKey: "k", suite: "s" });
    await client.postRunWithFiles(fixtureRun, {
      screenshots: [present, join(tmp, "gone.png")],
      videos: [join(tmp, "gone.webm")],
      snapshots: [],
    });

    const { url, form } = await uploadedFormData(fetchMock);
    // At least one real file exists → still the multipart path.
    assert.equal(url, "http://localhost:3000/runs/upload");

    const shots = form.getAll("screenshots") as File[];
    assert.equal(shots.length, 1);
    assert.equal(shots[0].name, "present.png");
    // The missing video was filtered out entirely.
    assert.equal(form.getAll("videos").length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("postRunWithFiles throws with status + body text on non-2xx upload", async () => {
  tmp = mkdtempSync(join(tmpdir(), "flakey-upload-"));
  try {
    const fetchMock = globalThis.fetch as ReturnType<typeof mock.fn>;
    fetchMock.mock.mockImplementation(async () =>
      new Response("payload too large", { status: 422 })
    );

    const shot = writeFixture("shot.png");
    const client = new ApiClient({ url: "http://localhost:3000", apiKey: "k", suite: "s" });
    await assert.rejects(
      () =>
        client.postRunWithFiles(fixtureRun, {
          screenshots: [shot],
          videos: [],
          snapshots: [],
        }),
      /Flakey API error 422: payload too large/
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
