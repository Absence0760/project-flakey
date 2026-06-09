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

// ── PR/MR selection edge cases ──────────────────────────────────────────
// Flakey comments on the OPEN PR/MR for a commit; commenting on a
// closed/merged/declined PR would be wrong. These pin the find-the-right-PR
// logic that drives where the test-results comment lands.

test("github: picks the open PR when it's not the first in the list", async () => {
  // GitHub returns associated PRs in no guaranteed order; the open one
  // (here, the 3rd) must win regardless of position.
  const restore = mockFetch(async () => jsonRes(200, [
    { number: 10, state: "closed" },
    { number: 20, state: "closed" },
    { number: 30, state: "open" },
    { number: 40, state: "closed" },
  ]));
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    const id = await p.findPRByCommit("deadbeef");
    assert.equal(id, 30, "the open PR must be selected even when it's not first");
  } finally {
    restore();
  }
});

test("github: falls back to the first PR when none are open", async () => {
  const restore = mockFetch(async () => jsonRes(200, [
    { number: 7, state: "merged" },
    { number: 8, state: "closed" },
  ]));
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    const id = await p.findPRByCommit("deadbeef");
    assert.equal(id, 7, "with no open PR, fall back to the first associated PR");
  } finally {
    restore();
  }
});

test("github: empty PR list yields null (no crash)", async () => {
  const restore = mockFetch(async () => jsonRes(200, []));
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    const id = await p.findPRByCommit("deadbeef");
    assert.equal(id, null, "a commit with zero associated PRs must resolve to null");
  } finally {
    restore();
  }
});

test("github: PR with a missing number is skipped without throwing", async () => {
  // A malformed/partial PR object (no `number`) must not crash the lookup;
  // selection falls through to a usable PR rather than commenting on
  // `undefined`.
  const restore = mockFetch(async () => jsonRes(200, [
    { state: "open" }, // open but no `number`
    { number: 99, state: "closed" },
  ]));
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    let id: number | null | undefined;
    await assert.doesNotReject(async () => { id = await p.findPRByCommit("deadbeef"); });
    // The open PR is also pulls[0], so `open?.number ?? pulls[0]?.number ?? null`
    // both fall through to null — a deliberate, safe outcome. The contract
    // that matters: never throw, never return `undefined` (which would post a
    // comment to PR "undefined").
    assert.equal(id, null, "missing number on the matched PR resolves to null, never undefined");
    assert.notEqual(id, undefined, "must never surface undefined as a PR number");
  } finally {
    restore();
  }
});

test("gitlab: prefers the 'opened' MR among opened/merged/closed", async () => {
  // GitLab's open state is the string "opened" (not "open"). The merged and
  // closed MRs must be ignored in favour of the opened one.
  const restore = mockFetch(async () => jsonRes(200, [
    { iid: 1, state: "merged" },
    { iid: 2, state: "closed" },
    { iid: 3, state: "opened" },
  ]));
  try {
    const p = createGitLabProvider({ platform: "gitlab", token: "t", repo: "g/p" });
    const iid = await p.findPRByCommit("deadbeef");
    assert.equal(iid, 3, "the 'opened' MR must win over merged/closed");
  } finally {
    restore();
  }
});

test("gitlab: falls back to the first MR when none are opened", async () => {
  const restore = mockFetch(async () => jsonRes(200, [
    { iid: 11, state: "merged" },
    { iid: 12, state: "closed" },
  ]));
  try {
    const p = createGitLabProvider({ platform: "gitlab", token: "t", repo: "g/p" });
    const iid = await p.findPRByCommit("deadbeef");
    assert.equal(iid, 11, "with no opened MR, fall back to the first");
  } finally {
    restore();
  }
});

test("gitlab: empty MR list yields null (no crash)", async () => {
  const restore = mockFetch(async () => jsonRes(200, []));
  try {
    const p = createGitLabProvider({ platform: "gitlab", token: "t", repo: "g/p" });
    const iid = await p.findPRByCommit("deadbeef");
    assert.equal(iid, null);
  } finally {
    restore();
  }
});

test("bitbucket: prefers the OPEN PR among OPEN/MERGED/DECLINED", async () => {
  // Bitbucket states are upper-case: OPEN / MERGED / DECLINED. Only OPEN
  // should be commented on.
  const restore = mockFetch(async () => jsonRes(200, {
    values: [
      { id: 101, state: "MERGED" },
      { id: 102, state: "DECLINED" },
      { id: 103, state: "OPEN" },
    ],
  }));
  try {
    const p = createBitbucketProvider({ platform: "bitbucket", token: "t", repo: "ws/repo" });
    const id = await p.findPRByCommit("deadbeef");
    assert.equal(id, 103, "the OPEN PR must win over MERGED/DECLINED");
  } finally {
    restore();
  }
});

test("bitbucket: falls back to the first PR when none are OPEN", async () => {
  const restore = mockFetch(async () => jsonRes(200, {
    values: [
      { id: 201, state: "MERGED" },
      { id: 202, state: "DECLINED" },
    ],
  }));
  try {
    const p = createBitbucketProvider({ platform: "bitbucket", token: "t", repo: "ws/repo" });
    const id = await p.findPRByCommit("deadbeef");
    assert.equal(id, 201, "with no OPEN PR, fall back to the first");
  } finally {
    restore();
  }
});

test("bitbucket: empty values array yields null (no crash)", async () => {
  const restore = mockFetch(async () => jsonRes(200, { values: [] }));
  try {
    const p = createBitbucketProvider({ platform: "bitbucket", token: "t", repo: "ws/repo" });
    const id = await p.findPRByCommit("deadbeef");
    assert.equal(id, null, "a commit with zero pull requests must resolve to null");
  } finally {
    restore();
  }
});

test("bitbucket: missing `values` key yields null (no crash)", async () => {
  // The optional-chaining on `data.values?.` guards a response shape that
  // omits the array entirely (e.g. an error envelope returned with a 200).
  const restore = mockFetch(async () => jsonRes(200, {}));
  try {
    const p = createBitbucketProvider({ platform: "bitbucket", token: "t", repo: "ws/repo" });
    let id: number | null = null;
    await assert.doesNotReject(async () => { id = await p.findPRByCommit("deadbeef"); });
    assert.equal(id, null);
  } finally {
    restore();
  }
});

// ── Repo-write: DRAFT fix PRs (B3) ──────────────────────────────────────────
// All three providers gained getDefaultBranch / getFileContent / createBranch /
// commitFile / createPullRequest so analyze.ts can open an AI-suggested fix as a
// DRAFT PR. Pin URL/method/body/auth shape + response parsing per platform.

// GitHub ----------------------------------------------------------------------

test("github: getDefaultBranch reads /repos then /git/ref and returns name+sha", async () => {
  const calls: string[] = [];
  const restore = mockFetch(async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/repos/o/r")) return jsonRes(200, { default_branch: "main" });
    if (u.includes("/git/ref/heads/main")) return jsonRes(200, { object: { sha: "abc123" } });
    return jsonRes(404, {});
  });
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    const res = await p.getDefaultBranch();
    assert.deepEqual(res, { name: "main", sha: "abc123" });
    assert.ok(calls.some((u) => u.includes("/git/ref/heads/main")));
  } finally {
    restore();
  }
});

test("github: getFileContent base64-decodes content and returns blob sha", async () => {
  let seenUrl = "";
  const restore = mockFetch(async (url) => {
    seenUrl = String(url);
    return jsonRes(200, {
      content: Buffer.from("hello world", "utf-8").toString("base64"),
      encoding: "base64",
      sha: "blob9",
    });
  });
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    const res = await p.getFileContent("src/a.ts", "main");
    assert.deepEqual(res, { content: "hello world", sha: "blob9" });
    assert.match(seenUrl, /\/repos\/o\/r\/contents\/src%2Fa\.ts\?ref=main$/);
  } finally {
    restore();
  }
});

test("github: getFileContent returns null on 404 (file absent)", async () => {
  const restore = mockFetch(async () => jsonRes(404, { message: "Not Found" }));
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    assert.equal(await p.getFileContent("nope.ts", "main"), null);
  } finally {
    restore();
  }
});

test("github: createBranch POSTs a refs/heads/<name> ref at fromSha", async () => {
  let seen: { url: string; method?: string; body: any } = { url: "", body: null };
  const restore = mockFetch(async (url, init) => {
    seen = { url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body as string) : null };
    return jsonRes(201, {});
  });
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    await p.createBranch("flakey/fix-1", "abc123");
    assert.match(seen.url, /\/repos\/o\/r\/git\/refs$/);
    assert.equal(seen.method, "POST");
    assert.equal(seen.body.ref, "refs/heads/flakey/fix-1");
    assert.equal(seen.body.sha, "abc123");
  } finally {
    restore();
  }
});

test("github: commitFile PUTs base64 content + sha when updating", async () => {
  let body: any = null;
  const restore = mockFetch(async (_url, init) => {
    body = init?.body ? JSON.parse(init.body as string) : null;
    return jsonRes(200, {});
  });
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    await p.commitFile({ branch: "b", path: "src/a.ts", content: "new code", message: "fix", sha: "old" });
    assert.equal(Buffer.from(body.content, "base64").toString("utf-8"), "new code");
    assert.equal(body.branch, "b");
    assert.equal(body.sha, "old");
    assert.equal(body.message, "fix");
  } finally {
    restore();
  }
});

test("github: commitFile omits sha when creating a new file", async () => {
  let body: any = null;
  const restore = mockFetch(async (_url, init) => {
    body = init?.body ? JSON.parse(init.body as string) : null;
    return jsonRes(201, {});
  });
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    await p.commitFile({ branch: "b", path: "new.ts", content: "x", message: "add" });
    assert.equal("sha" in body, false, "no sha key on create");
  } finally {
    restore();
  }
});

test("github: createPullRequest POSTs draft:true and maps html_url→url", async () => {
  let seen: { url: string; method?: string; body: any } = { url: "", body: null };
  const restore = mockFetch(async (url, init) => {
    seen = { url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body as string) : null };
    return jsonRes(201, { number: 77, html_url: "https://github.com/o/r/pull/77" });
  });
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    const res = await p.createPullRequest({ head: "fix", base: "main", title: "T", body: "B", draft: true });
    assert.match(seen.url, /\/repos\/o\/r\/pulls$/);
    assert.equal(seen.body.draft, true);
    assert.equal(seen.body.head, "fix");
    assert.equal(seen.body.base, "main");
    assert.deepEqual(res, { number: 77, url: "https://github.com/o/r/pull/77" });
  } finally {
    restore();
  }
});

test("github: createPullRequest throws on 422 (validation)", async () => {
  const restore = mockFetch(async () => jsonRes(422, { message: "A pull request already exists" }));
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    await assert.rejects(
      () => p.createPullRequest({ head: "fix", base: "main", title: "T", body: "B", draft: true }),
      /422/,
    );
  } finally {
    restore();
  }
});

// GitLab ----------------------------------------------------------------------

test("gitlab: getDefaultBranch reads project default_branch then branch commit id", async () => {
  const restore = mockFetch(async (url) => {
    const u = String(url);
    if (/\/projects\/[^/]+$/.test(u)) return jsonRes(200, { default_branch: "main" });
    if (u.includes("/repository/branches/main")) return jsonRes(200, { commit: { id: "sha9" } });
    return jsonRes(404, {});
  });
  try {
    const p = createGitLabProvider({ platform: "gitlab", token: "t", repo: "g/p" });
    assert.deepEqual(await p.getDefaultBranch(), { name: "main", sha: "sha9" });
  } finally {
    restore();
  }
});

test("gitlab: getFileContent base64-decodes and returns blob_id as sha", async () => {
  let seenUrl = "";
  const restore = mockFetch(async (url) => {
    seenUrl = String(url);
    return jsonRes(200, {
      content: Buffer.from("body", "utf-8").toString("base64"),
      encoding: "base64",
      blob_id: "bid1",
    });
  });
  try {
    const p = createGitLabProvider({ platform: "gitlab", token: "t", repo: "g/p" });
    const res = await p.getFileContent("dir/f.ts", "main");
    assert.deepEqual(res, { content: "body", sha: "bid1" });
    assert.match(seenUrl, /\/repository\/files\/dir%2Ff\.ts\?ref=main$/);
  } finally {
    restore();
  }
});

test("gitlab: getFileContent returns null on 404", async () => {
  const restore = mockFetch(async () => jsonRes(404, { message: "404 File Not Found" }));
  try {
    const p = createGitLabProvider({ platform: "gitlab", token: "t", repo: "g/p" });
    assert.equal(await p.getFileContent("nope", "main"), null);
  } finally {
    restore();
  }
});

test("gitlab: createBranch POSTs with branch + ref query params", async () => {
  let seen: { url: string; method?: string } = { url: "" };
  const restore = mockFetch(async (url, init) => {
    seen = { url: String(url), method: init?.method };
    return jsonRes(201, {});
  });
  try {
    const p = createGitLabProvider({ platform: "gitlab", token: "t", repo: "g/p" });
    await p.createBranch("fix-x", "sha9");
    assert.equal(seen.method, "POST");
    assert.match(seen.url, /\/repository\/branches\?branch=fix-x&ref=sha9$/);
  } finally {
    restore();
  }
});

test("gitlab: commitFile PUTs when file exists (probe returns 200)", async () => {
  const methods: string[] = [];
  const restore = mockFetch(async (url, init) => {
    const u = String(url);
    if (init?.method === undefined || init?.method === "GET") {
      // the existence probe (getFileContent)
      return jsonRes(200, { content: Buffer.from("old").toString("base64"), encoding: "base64", blob_id: "b" });
    }
    methods.push(`${init?.method} ${u.includes("/repository/files/") ? "files" : "other"}`);
    return jsonRes(200, {});
  });
  try {
    const p = createGitLabProvider({ platform: "gitlab", token: "t", repo: "g/p" });
    await p.commitFile({ branch: "b", path: "f.ts", content: "new", message: "m" });
    assert.deepEqual(methods, ["PUT files"]);
  } finally {
    restore();
  }
});

test("gitlab: commitFile POSTs when file is new (probe returns 404)", async () => {
  const methods: string[] = [];
  const restore = mockFetch(async (url, init) => {
    if (init?.method === undefined || init?.method === "GET") return jsonRes(404, {});
    methods.push(String(init?.method));
    return jsonRes(201, {});
  });
  try {
    const p = createGitLabProvider({ platform: "gitlab", token: "t", repo: "g/p" });
    await p.commitFile({ branch: "b", path: "new.ts", content: "x", message: "m" });
    assert.deepEqual(methods, ["POST"]);
  } finally {
    restore();
  }
});

test("gitlab: createMergeRequest prefixes Draft: and maps iid→number, web_url→url", async () => {
  let body: any = null;
  const restore = mockFetch(async (_url, init) => {
    body = init?.body ? JSON.parse(init.body as string) : null;
    return jsonRes(201, { iid: 12, web_url: "https://gitlab.com/g/p/-/merge_requests/12" });
  });
  try {
    const p = createGitLabProvider({ platform: "gitlab", token: "t", repo: "g/p" });
    const res = await p.createPullRequest({ head: "fix", base: "main", title: "T", body: "B", draft: true });
    assert.equal(body.title, "Draft: T");
    assert.equal(body.source_branch, "fix");
    assert.equal(body.target_branch, "main");
    assert.deepEqual(res, { number: 12, url: "https://gitlab.com/g/p/-/merge_requests/12" });
  } finally {
    restore();
  }
});

test("gitlab: createMergeRequest leaves title unprefixed when draft=false", async () => {
  let title = "";
  const restore = mockFetch(async (_url, init) => {
    title = JSON.parse(init!.body as string).title;
    return jsonRes(201, { iid: 1, web_url: "u" });
  });
  try {
    const p = createGitLabProvider({ platform: "gitlab", token: "t", repo: "g/p" });
    await p.createPullRequest({ head: "h", base: "b", title: "Plain", body: "x", draft: false });
    assert.equal(title, "Plain");
  } finally {
    restore();
  }
});

// Bitbucket -------------------------------------------------------------------

test("bitbucket: getDefaultBranch reads mainbranch then branch target hash", async () => {
  const restore = mockFetch(async (url) => {
    const u = String(url);
    if (/\/repositories\/ws\/repo$/.test(u)) return jsonRes(200, { mainbranch: { name: "main" } });
    if (u.includes("/refs/branches/main")) return jsonRes(200, { target: { hash: "h9" } });
    return jsonRes(404, {});
  });
  try {
    const p = createBitbucketProvider({ platform: "bitbucket", token: "t", repo: "ws/repo" });
    assert.deepEqual(await p.getDefaultBranch(), { name: "main", sha: "h9" });
  } finally {
    restore();
  }
});

test("bitbucket: getFileContent returns raw text and the ref as sha", async () => {
  let seenUrl = "";
  const restore = mockFetch(async (url) => {
    seenUrl = String(url);
    return new Response("raw file body", { status: 200 });
  });
  try {
    const p = createBitbucketProvider({ platform: "bitbucket", token: "t", repo: "ws/repo" });
    const res = await p.getFileContent("src/a.ts", "abc");
    assert.deepEqual(res, { content: "raw file body", sha: "abc" });
    assert.match(seenUrl, /\/repositories\/ws\/repo\/src\/abc\/src\/a\.ts$/);
  } finally {
    restore();
  }
});

test("bitbucket: getFileContent returns null on 404", async () => {
  const restore = mockFetch(async () => new Response("Not found", { status: 404 }));
  try {
    const p = createBitbucketProvider({ platform: "bitbucket", token: "t", repo: "ws/repo" });
    assert.equal(await p.getFileContent("nope", "abc"), null);
  } finally {
    restore();
  }
});

test("bitbucket: createBranch POSTs name + target.hash", async () => {
  let body: any = null;
  const restore = mockFetch(async (_url, init) => {
    body = init?.body ? JSON.parse(init.body as string) : null;
    return jsonRes(201, {});
  });
  try {
    const p = createBitbucketProvider({ platform: "bitbucket", token: "t", repo: "ws/repo" });
    await p.createBranch("fix-x", "h9");
    assert.equal(body.name, "fix-x");
    assert.deepEqual(body.target, { hash: "h9" });
  } finally {
    restore();
  }
});

test("bitbucket: commitFile form-encodes path→content, branch, message", async () => {
  let contentType = "";
  let parsed: URLSearchParams | null = null;
  const restore = mockFetch(async (url, init) => {
    contentType = (init?.headers as any)?.["Content-Type"] ?? "";
    parsed = new URLSearchParams(init?.body as string);
    assert.match(String(url), /\/repositories\/ws\/repo\/src$/);
    return jsonRes(201, {});
  });
  try {
    const p = createBitbucketProvider({ platform: "bitbucket", token: "t", repo: "ws/repo" });
    await p.commitFile({ branch: "b", path: "src/a.ts", content: "new code", message: "fix" });
    assert.equal(contentType, "application/x-www-form-urlencoded");
    assert.equal(parsed!.get("src/a.ts"), "new code");
    assert.equal(parsed!.get("branch"), "b");
    assert.equal(parsed!.get("message"), "fix");
  } finally {
    restore();
  }
});

test("bitbucket: createPullRequest opens normally + prefixes AI note, maps id→number and links.html.href→url", async () => {
  let body: any = null;
  const restore = mockFetch(async (_url, init) => {
    body = init?.body ? JSON.parse(init.body as string) : null;
    return jsonRes(201, { id: 5, links: { html: { href: "https://bitbucket.org/ws/repo/pull-requests/5" } } });
  });
  try {
    const p = createBitbucketProvider({ platform: "bitbucket", token: "t", repo: "ws/repo" });
    const res = await p.createPullRequest({ head: "fix", base: "main", title: "T", body: "Body", draft: true });
    assert.equal(body.source.branch.name, "fix");
    assert.equal(body.destination.branch.name, "main");
    assert.match(body.description, /AI-generated/i, "draft note is prefixed since Bitbucket has no draft flag");
    assert.match(body.description, /Body/);
    assert.deepEqual(res, { number: 5, url: "https://bitbucket.org/ws/repo/pull-requests/5" });
  } finally {
    restore();
  }
});

test("bitbucket: createPullRequest does not prefix the AI note when draft=false", async () => {
  let description = "";
  const restore = mockFetch(async (_url, init) => {
    description = JSON.parse(init!.body as string).description;
    return jsonRes(201, { id: 1, links: { html: { href: "u" } } });
  });
  try {
    const p = createBitbucketProvider({ platform: "bitbucket", token: "t", repo: "ws/repo" });
    await p.createPullRequest({ head: "h", base: "b", title: "T", body: "Plain", draft: false });
    assert.equal(description, "Plain");
  } finally {
    restore();
  }
});

// getProviderForOrg is covered by analyze-route tests (needs a DB); the export
// existence is asserted here so the wiring can't silently disappear.
test("index: getProviderForOrg is exported", async () => {
  const mod = await import("../git-providers/index.js");
  assert.equal(typeof mod.getProviderForOrg, "function");
});

// ── GitHub Checks annotations (Phase 14) ────────────────────────────────────

import { buildCheckAnnotations, MAX_ANNOTATIONS } from "../git-providers/annotations.js";
import type { NormalizedRun } from "../types.js";

function runWith(tests: NormalizedRun["specs"][number]["tests"]): NormalizedRun {
  const failed = tests.filter((t) => t.status === "failed").length;
  return {
    meta: { suite_name: "s", branch: "main", commit_sha: "abc", ci_run_id: "1", started_at: "", finished_at: "", reporter: "playwright" },
    stats: { total: tests.length, passed: tests.length - failed, failed, skipped: 0, pending: 0, duration_ms: 0 },
    specs: [{ file_path: "spec.ts", title: "Spec", stats: { total: tests.length, passed: tests.length - failed, failed, skipped: 0, pending: 0, duration_ms: 0 }, tests }],
  };
}

test("buildCheckAnnotations: derives path+line from Playwright metadata.location", () => {
  const run = runWith([
    { title: "a", full_title: "S > a", status: "failed", duration_ms: 1, screenshot_paths: [],
      error: { message: "expected 1 to equal 2\n  at thing" },
      metadata: { location: { file: "tests/login.spec.ts", line: 42, column: 3 } } },
    { title: "b", full_title: "S > b", status: "passed", duration_ms: 1, screenshot_paths: [] },
  ]);
  const ann = buildCheckAnnotations(run);
  assert.equal(ann.length, 1, "only the failed test is annotated");
  assert.equal(ann[0].path, "tests/login.spec.ts");
  assert.equal(ann[0].start_line, 42);
  assert.equal(ann[0].annotation_level, "failure");
  assert.equal(ann[0].title, "S > a");
  assert.match(ann[0].message, /expected 1 to equal 2/);
});

test("buildCheckAnnotations: falls back to Cypress failure_context.code_frame", () => {
  const run = runWith([
    { title: "c", full_title: "S > c", status: "failed", duration_ms: 1, screenshot_paths: [],
      error: { message: "boom" },
      failure_context: { code_frame: { file: "./cypress/e2e/auth.cy.ts", line: 7 } } },
  ]);
  const ann = buildCheckAnnotations(run);
  assert.equal(ann[0].path, "cypress/e2e/auth.cy.ts", "leading ./ stripped");
  assert.equal(ann[0].start_line, 7);
});

test("buildCheckAnnotations: skips failed tests with no known location (mochawesome/JUnit)", () => {
  const run = runWith([
    { title: "d", full_title: "S > d", status: "failed", duration_ms: 1, screenshot_paths: [], error: { message: "x" } },
  ]);
  assert.equal(buildCheckAnnotations(run).length, 0);
});

test("buildCheckAnnotations: caps at MAX_ANNOTATIONS", () => {
  const tests = Array.from({ length: MAX_ANNOTATIONS + 25 }, (_, i) => ({
    title: `t${i}`, full_title: `S > t${i}`, status: "failed" as const, duration_ms: 1, screenshot_paths: [],
    error: { message: "e" }, metadata: { location: { file: "f.ts", line: i + 1 } },
  }));
  assert.equal(buildCheckAnnotations(runWith(tests)).length, MAX_ANNOTATIONS);
});

test("github: postChecksAnnotations creates a completed check-run with the failure conclusion", async () => {
  const calls: Array<{ url: string; method?: string; body: any }> = [];
  const restore = mockFetch(async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body as string) : null });
    return jsonRes(201, { id: 999 });
  });
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    await p.postChecksAnnotations!({
      commitSha: "deadbeef", name: "flakey/suite", title: "1 failed", summary: "s",
      conclusion: "failure", detailsUrl: "http://x/runs/1",
      annotations: [{ path: "a.ts", start_line: 1, end_line: 1, annotation_level: "failure", message: "m" }],
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/repos\/o\/r\/check-runs$/);
    assert.equal(calls[0].body.head_sha, "deadbeef");
    assert.equal(calls[0].body.status, "completed");
    assert.equal(calls[0].body.conclusion, "failure");
    assert.equal(calls[0].body.output.annotations.length, 1);
  } finally {
    restore();
  }
});

test("github: postChecksAnnotations batches >50 annotations into create + PATCH(es)", async () => {
  const calls: Array<{ url: string; method?: string; count: number }> = [];
  const restore = mockFetch(async (url, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    calls.push({ url: String(url), method: init?.method, count: body.output?.annotations?.length ?? 0 });
    return jsonRes(init?.method === "POST" ? 201 : 200, { id: 7 });
  });
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    const annotations = Array.from({ length: 120 }, (_, i) => ({
      path: "a.ts", start_line: i + 1, end_line: i + 1, annotation_level: "failure" as const, message: "m",
    }));
    await p.postChecksAnnotations!({
      commitSha: "sha", name: "n", title: "t", summary: "s", conclusion: "failure", detailsUrl: "u", annotations,
    });
    // 120 → create(50) + patch(50) + patch(20) = 3 calls
    assert.equal(calls.length, 3);
    assert.equal(calls[0].method, "POST"); assert.equal(calls[0].count, 50);
    assert.equal(calls[1].method, "PATCH"); assert.equal(calls[1].count, 50);
    assert.equal(calls[2].method, "PATCH"); assert.equal(calls[2].count, 20);
    assert.match(calls[1].url, /\/check-runs\/7$/, "PATCHes target the created check-run id");
  } finally {
    restore();
  }
});

test("github: postChecksAnnotations throws on 403 (token lacks checks:write)", async () => {
  const restore = mockFetch(async () => jsonRes(403, { message: "Resource not accessible" }));
  try {
    const p = createGitHubProvider({ platform: "github", token: "t", repo: "o/r" });
    await assert.rejects(
      () => p.postChecksAnnotations!({ commitSha: "s", name: "n", title: "t", summary: "s", conclusion: "neutral", detailsUrl: "u", annotations: [] }),
      /403/,
    );
  } finally {
    restore();
  }
});

// ── Quarantine-gate decision (Feature A: soften the external merge check) ────
//
// postPRComment relaxes ONLY the external git merge gate (commit status /
// Checks conclusion) when every failed test in a run is quarantined. The
// decision is extracted into computeAllFailuresQuarantined so it can be
// unit-tested without standing up a provider + DB. The three cases below pin
// the contract; postPRComment delegates to this exact function.

import { computeAllFailuresQuarantined } from "../git-providers/index.js";

test("computeAllFailuresQuarantined: every failed test quarantined → true (soften the gate)", () => {
  const failed = ["Suite > a flaky test", "Suite > another flaky test"];
  const quarantined = new Set(failed);
  assert.equal(
    computeAllFailuresQuarantined(failed, quarantined),
    true,
    "when all failures are quarantined the external merge gate is softened",
  );
});

test("computeAllFailuresQuarantined: one genuine (non-quarantined) failure → false", () => {
  const failed = ["Suite > a flaky test", "Suite > a real regression"];
  // Only the flaky one is quarantined; the real regression must keep the gate red.
  const quarantined = new Set(["Suite > a flaky test"]);
  assert.equal(
    computeAllFailuresQuarantined(failed, quarantined),
    false,
    "a single non-quarantined failure must keep the merge gate failing",
  );
});

test("computeAllFailuresQuarantined: empty failedTitles → false (fail-closed guard)", () => {
  // stats.failed > 0 but no status==='failed' tests in specs (a normalizer
  // quirk) yields an empty title list. `nonQuarantinedFailed === 0` would
  // vacuously soften a genuinely-failed run — the helper must fail closed.
  assert.equal(
    computeAllFailuresQuarantined([], new Set(["anything"])),
    false,
    "empty failedTitles must NOT soften the gate (fail-closed)",
  );
  // Also fail-closed when there are simply no quarantine entries at all.
  assert.equal(computeAllFailuresQuarantined([], new Set<string>()), false);
});
