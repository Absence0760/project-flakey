/**
 * Git provider unit tests.
 *
 * These run against the real provider factories with `fetch` mocked.
 * Pin the contract:
 *   - mutating calls (POST/PATCH) MUST throw on non-2xx so the wrapping
 *     try/catch in postPRComment surfaces a log line.  Silent no-op on a
 *     bad token would leave operators thinking the integration works.
 *   - all calls MUST honour a timeout.  fetch() has no default timeout,
 *     so a hung GitHub.com would stall every upload's post-processing.
 *   - read calls (find*) may degrade to null on non-2xx — they're best-
 *     effort lookups, not state mutations.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGitHubProvider } from "../git-providers/github.js";
import { createGitLabProvider } from "../git-providers/gitlab.js";
import { createBitbucketProvider } from "../git-providers/bitbucket.js";

type Mock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function mockFetch(impl: Mock) {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Authorization header is set on every call ───────────────────────────

test("github: every request carries the Bearer token", async () => {
  let seenAuth: string | null = null;
  const restore = mockFetch(async (_url, init) => {
    seenAuth = (init?.headers as any)?.Authorization ?? null;
    return jsonRes(200, []);
  });
  try {
    const p = createGitHubProvider({
      platform: "github", token: "xyz", repo: "o/r",
    });
    await p.findPRByCommit("deadbeef");
    assert.equal(seenAuth, "Bearer xyz");
  } finally {
    restore();
  }
});

// ── Mutating calls throw on non-2xx ─────────────────────────────────────

test("github: createComment throws when GitHub returns 401 (bad token)", async () => {
  const restore = mockFetch(async () => jsonRes(401, { message: "Bad credentials" }));
  try {
    const p = createGitHubProvider({ platform: "github", token: "bad", repo: "o/r" });
    await assert.rejects(
      () => p.createComment(42, "body"),
      /401|Bad credentials/i,
      "createComment must surface 401 so postPRComment logs it"
    );
  } finally {
    restore();
  }
});

test("github: updateComment throws on 422", async () => {
  const restore = mockFetch(async () => jsonRes(422, { message: "Validation failed" }));
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    await assert.rejects(
      () => p.updateComment(42, 123, "body"),
      /422|Validation failed/i
    );
  } finally {
    restore();
  }
});

test("github: postCommitStatus throws on 404 (commit doesn't exist)", async () => {
  const restore = mockFetch(async () => jsonRes(404, { message: "Not Found" }));
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    await assert.rejects(
      () => p.postCommitStatus({
        commitSha: "deadbeef",
        state: "success",
        targetUrl: "http://x",
        description: "ok",
        context: "flakey/smoke",
      }),
      /404|Not Found/i
    );
  } finally {
    restore();
  }
});

test("github: createComment succeeds quietly on 201", async () => {
  const restore = mockFetch(async () => jsonRes(201, { id: 999 }));
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    await assert.doesNotReject(() => p.createComment(42, "body"));
  } finally {
    restore();
  }
});

// ── Read calls degrade gracefully to null on non-2xx ────────────────────

test("github: findPRByCommit returns null on 404 (no PR for this commit)", async () => {
  const restore = mockFetch(async () => jsonRes(404, { message: "Not Found" }));
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    const id = await p.findPRByCommit("deadbeef");
    assert.equal(id, null, "missing-PR lookups should be null, not throw");
  } finally {
    restore();
  }
});

test("github: findPRByCommit prefers an open PR over a closed one", async () => {
  const restore = mockFetch(async () => jsonRes(200, [
    { number: 100, state: "closed" },
    { number: 200, state: "open" },
  ]));
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    const id = await p.findPRByCommit("deadbeef");
    assert.equal(id, 200, "open PR should win over closed when both reference the same commit");
  } finally {
    restore();
  }
});

test("github: findPRByCommit falls back to the first PR if none are open", async () => {
  const restore = mockFetch(async () => jsonRes(200, [
    { number: 50, state: "closed" },
    { number: 51, state: "merged" },
  ]));
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    const id = await p.findPRByCommit("deadbeef");
    assert.equal(id, 50);
  } finally {
    restore();
  }
});

test("github: findExistingComment matches by COMMENT_MARKER, not by author", async () => {
  // Comments from any user that contain the marker should be reused for
  // edits.  This avoids spamming a PR with multiple comments when token
  // rotation switches the bot account.
  const restore = mockFetch(async () => jsonRes(200, [
    { id: 1, body: "regular comment" },
    { id: 2, body: "<!-- flakey-pr-comment -->\n# Test results\n..." },
    { id: 3, body: "another regular" },
  ]));
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    const id = await p.findExistingComment(42);
    assert.equal(id, 2);
  } finally {
    restore();
  }
});

// ── Timeout enforcement ──────────────────────────────────────────────────

test("github: requests carry an AbortSignal (defends against hangs)", async () => {
  let seenSignal: AbortSignal | undefined;
  const restore = mockFetch(async (_url, init) => {
    seenSignal = init?.signal as AbortSignal | undefined;
    return jsonRes(200, []);
  });
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    await p.findPRByCommit("deadbeef");
    assert.ok(seenSignal, "fetch must be called with a signal so the request is cancellable");
    assert.ok(typeof seenSignal!.aborted === "boolean", "signal looks like an AbortSignal");
  } finally {
    restore();
  }
});

// ── Base URL override (GitHub Enterprise) ───────────────────────────────

test("github: baseUrl override is used for self-hosted enterprise", async () => {
  let seenUrl = "";
  const restore = mockFetch(async (url) => {
    seenUrl = url.toString();
    return jsonRes(200, []);
  });
  try {
    const p = createGitHubProvider({
      platform: "github", token: "t", repo: "o/r",
      baseUrl: "https://github.acme.com/api/v3",
    });
    await p.findPRByCommit("deadbeef");
    assert.ok(seenUrl.startsWith("https://github.acme.com/api/v3/"), `URL was ${seenUrl}`);
  } finally {
    restore();
  }
});

// ── GitLab parity ────────────────────────────────────────────────────────

test("gitlab: createComment throws on 401", async () => {
  const restore = mockFetch(async () => jsonRes(401, { message: "Unauthorized" }));
  try {
    const p = createGitLabProvider({ platform: "gitlab", token: "bad", repo: "group/proj" });
    await assert.rejects(() => p.createComment(42, "body"), /401/);
  } finally {
    restore();
  }
});

test("gitlab: postCommitStatus translates state names (failure → failed)", async () => {
  let seenState = "";
  const restore = mockFetch(async (_url, init) => {
    if (init?.body) {
      const parsed = JSON.parse(init.body as string);
      seenState = parsed.state;
    }
    return jsonRes(201, {});
  });
  try {
    const p = createGitLabProvider({ platform: "gitlab", token: "t", repo: "g/p" });
    await p.postCommitStatus({
      commitSha: "deadbeef", state: "failure", targetUrl: "http://x",
      description: "d", context: "c",
    });
    assert.equal(seenState, "failed", "GitLab uses 'failed' not 'failure'");
  } finally {
    restore();
  }
});

test("gitlab: encodes the project path for namespaced repos (group/sub/proj)", async () => {
  let seenUrl = "";
  const restore = mockFetch(async (url) => {
    seenUrl = url.toString();
    return jsonRes(200, []);
  });
  try {
    const p = createGitLabProvider({ platform: "gitlab", token: "t", repo: "group/sub/proj" });
    await p.findPRByCommit("deadbeef");
    // Slashes in the repo path must be URL-encoded as %2F so GitLab's
    // single-path-segment project-id lookup works.
    assert.ok(seenUrl.includes("group%2Fsub%2Fproj"), `expected encoded path in ${seenUrl}`);
  } finally {
    restore();
  }
});

test("gitlab: requests carry an AbortSignal", async () => {
  let seenSignal: AbortSignal | undefined;
  const restore = mockFetch(async (_url, init) => {
    seenSignal = init?.signal as AbortSignal | undefined;
    return jsonRes(200, []);
  });
  try {
    const p = createGitLabProvider({ platform: "gitlab", token: "t", repo: "g/p" });
    await p.findPRByCommit("deadbeef");
    assert.ok(seenSignal, "fetch must be called with a signal");
  } finally {
    restore();
  }
});

// ── Bitbucket parity ────────────────────────────────────────────────────

test("bitbucket: createComment throws on 403 (insufficient scope)", async () => {
  const restore = mockFetch(async () => jsonRes(403, { error: { message: "forbidden" } }));
  try {
    const p = createBitbucketProvider({ platform: "bitbucket", token: "t", repo: "ws/repo" });
    await assert.rejects(() => p.createComment(42, "body"), /403/);
  } finally {
    restore();
  }
});

test("bitbucket: postCommitStatus translates state to SUCCESSFUL/FAILED", async () => {
  let seenState = "";
  const restore = mockFetch(async (_url, init) => {
    if (init?.body) seenState = JSON.parse(init.body as string).state;
    return jsonRes(201, {});
  });
  try {
    const p = createBitbucketProvider({ platform: "bitbucket", token: "t", repo: "ws/repo" });
    await p.postCommitStatus({
      commitSha: "deadbeef", state: "success", targetUrl: "http://x",
      description: "d", context: "c",
    });
    assert.equal(seenState, "SUCCESSFUL");
  } finally {
    restore();
  }
});

test("bitbucket: requests carry an AbortSignal", async () => {
  let seenSignal: AbortSignal | undefined;
  const restore = mockFetch(async (_url, init) => {
    seenSignal = init?.signal as AbortSignal | undefined;
    return jsonRes(200, { values: [] });
  });
  try {
    const p = createBitbucketProvider({ platform: "bitbucket", token: "t", repo: "ws/repo" });
    await p.findPRByCommit("deadbeef");
    assert.ok(seenSignal);
  } finally {
    restore();
  }
});

test("bitbucket: findExistingComment matches body via content.raw", async () => {
  const restore = mockFetch(async () => jsonRes(200, {
    values: [
      { id: 1, content: { raw: "regular" } },
      { id: 2, content: { raw: "<!-- flakey-pr-comment -->\nstuff" } },
    ],
  }));
  try {
    const p = createBitbucketProvider({ platform: "bitbucket", token: "t", repo: "ws/repo" });
    const id = await p.findExistingComment(42);
    assert.equal(id, 2);
  } finally {
    restore();
  }
});
