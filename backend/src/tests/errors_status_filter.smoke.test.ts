/**
 * Error-group status-filter smoke tests — protects GET /errors?status=…
 *
 * The errors dashboard (frontend/src/routes/(app)/errors/+page.svelte) sends
 * the selected status tab server-side (?status=open|investigating|known|
 * fixed|ignored). The route aggregates error groups, keeps the 100 most
 * recent, and returns them.
 *
 * Regression guard: the status filter MUST be applied before that top-100
 * LIMIT. Earlier the LIMIT ran first and the status filter ran in JS after,
 * so a status rarer than the 100 most-recent groups (e.g. a handful of older
 * `fixed` groups behind 100 newer `open` ones) was silently truncated to an
 * empty list even though the matching groups existed.
 *
 * Each test registers its OWN org and uploads its OWN runs, so assertions
 * never depend on seed data or other agents sharing this DB. Fingerprints
 * are discovered via the suite-filtered endpoint (the suite filter runs
 * inside the aggregation, before the LIMIT) rather than recomputed locally,
 * so the test stays honest about whatever the normalizer stores.
 *
 * Route under test: src/routes/errors.ts.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3975;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;

async function waitForHealth(maxMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* retry until healthy */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Backend did not become healthy in time");
}

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "flaky-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

/** Register a brand-new org and return its bearer token. */
async function registerOrg(label: string): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `${label}+${stamp}@test.local`,
      password: "testpass123",
      name: label,
      org_name: `${label}-${stamp}`,
    }),
  });
  if (!reg.ok) {
    throw new Error(`register failed: ${reg.status} ${await reg.text().catch(() => "")}`);
  }
  return ((await reg.json()) as { token: string }).token;
}

/**
 * Upload one run of `suite` whose failed tests each carry a DISTINCT error
 * message — every (error_message, suite) pair becomes its own error group.
 * Awaited fully so the run's created_at advances strictly before the next
 * upload, which makes last_seen recency deterministic across runs.
 */
async function uploadFailingRun(token: string, suite: string, errorMessages: string[]): Promise<void> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tests = errorMessages.map((msg, i) => ({
    title: `case ${i}`,
    full_title: `${suite} > case ${i}`,
    status: "failed" as const,
    duration_ms: 10,
    screenshot_paths: [],
    error: { message: msg, stack: `${msg}\n    at line 1` },
  }));
  const fd = new FormData();
  fd.append(
    "payload",
    JSON.stringify({
      meta: {
        suite_name: suite,
        branch: "main",
        commit_sha: stamp,
        ci_run_id: `ci-${suite}-${stamp}`,
        started_at: "2026-04-10T00:00:00Z",
        finished_at: "2026-04-10T00:00:30Z",
        reporter: "mochawesome",
      },
      stats: { total: tests.length, passed: 0, failed: tests.length, skipped: 0, pending: 0, duration_ms: 1000 },
      specs: [
        {
          file_path: `${suite}.cy.ts`,
          title: suite,
          stats: { total: tests.length, passed: 0, failed: tests.length, skipped: 0, duration_ms: 1000 },
          tests,
        },
      ],
    })
  );
  const up = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!up.ok) {
    throw new Error(`upload failed: ${up.status} ${await up.text().catch(() => "")}`);
  }
}

interface ErrorGroupRow {
  fingerprint: string;
  error_message: string;
  suite_name: string;
  status: string;
  note_count: number;
}

async function getErrors(token: string, query = ""): Promise<{ rows: ErrorGroupRow[]; res: Response }> {
  const res = await fetch(`${BASE}/errors${query}`, { headers: { Authorization: `Bearer ${token}` } });
  const rows = (await res.json()) as ErrorGroupRow[];
  return { rows, res };
}

async function setStatus(token: string, fingerprint: string, status: string): Promise<Response> {
  return fetch(`${BASE}/errors/${fingerprint}/status`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

// ── the regression: status filter must run before the top-100 LIMIT ──────

test("status=fixed returns matching groups ranked outside the 100 most-recent", async () => {
  const token = await registerOrg("errstatus-trunc");
  const stamp = `${Date.now()}`;
  const oldSuite = `errstatus-old-${stamp}`;
  const newSuite = `errstatus-new-${stamp}`;

  // 3 older groups we will mark `fixed`...
  const oldMessages = ["OldErr-A", "OldErr-B", "OldErr-C"];
  await uploadFailingRun(token, oldSuite, oldMessages);
  // ...then 102 newer `open` groups that fully consume the top-100 window.
  const newMessages = Array.from({ length: 102 }, (_, i) => `NewErr-${i}`);
  await uploadFailingRun(token, newSuite, newMessages);

  // Discover the 3 old fingerprints via the suite filter (runs inside the
  // aggregation, before the LIMIT) and mark each `fixed`.
  const { rows: oldRows } = await getErrors(token, `?suite=${encodeURIComponent(oldSuite)}`);
  assert.equal(oldRows.length, 3, "suite-filtered view should surface all 3 old groups");
  for (const row of oldRows) {
    const patch = await setStatus(token, row.fingerprint, "fixed");
    assert.equal(patch.status, 200, `PATCH status fixed failed for ${row.error_message}`);
  }

  // Unfiltered: the 102 newer groups fill the 100-row window; the older fixed
  // groups are ranked out — this is exactly the condition under which the old
  // post-LIMIT JS filter returned an empty list for status=fixed.
  const { rows: allRows } = await getErrors(token);
  assert.equal(allRows.length, 100, "unfiltered view is capped at 100 rows");
  const oldFps = new Set(oldRows.map((r) => r.fingerprint));
  assert.ok(
    allRows.every((r) => !oldFps.has(r.fingerprint)),
    "older fixed groups must be ranked outside the unfiltered top-100"
  );

  // The fix: filtering by status applies BEFORE the LIMIT, so the 3 fixed
  // groups come back even though they're not in the 100 most-recent.
  const { rows: fixedRows, res } = await getErrors(token, "?status=fixed");
  assert.equal(res.status, 200);
  assert.equal(fixedRows.length, 3, "status=fixed must return all matching groups, not just recent ones");
  assert.deepEqual(
    fixedRows.map((r) => r.error_message).sort(),
    [...oldMessages].sort(),
    "the fixed groups returned are the 3 we stamped"
  );
  assert.ok(fixedRows.every((r) => r.status === "fixed"), "every returned group is fixed");
});

// ── basic correctness of the filter + the surrounding endpoints ──────────

test("status filter narrows to the requested status and excludes others", async () => {
  const token = await registerOrg("errstatus-basic");
  const suite = `errstatus-basic-${Date.now()}`;
  await uploadFailingRun(token, suite, ["BasicErr-open", "BasicErr-investigating"]);

  const { rows } = await getErrors(token, `?suite=${encodeURIComponent(suite)}`);
  assert.equal(rows.length, 2);
  const investigating = rows.find((r) => r.error_message === "BasicErr-investigating")!;
  assert.equal(await (await setStatus(token, investigating.fingerprint, "investigating")).status, 200);

  const { rows: invRows } = await getErrors(token, "?status=investigating");
  assert.ok(
    invRows.some((r) => r.fingerprint === investigating.fingerprint),
    "investigating group appears under status=investigating"
  );
  assert.ok(
    invRows.every((r) => r.status === "investigating"),
    "no non-investigating groups leak into status=investigating"
  );

  const { rows: openRows } = await getErrors(token, "?status=open");
  assert.ok(
    !openRows.some((r) => r.fingerprint === investigating.fingerprint),
    "the investigating group must NOT appear under status=open"
  );
});

// ── status=regressed must return ONLY regressed groups ───────────────────
//
// 'regressed' was added to VALID_STATUSES alongside the Phase 15.2 recurrence
// hook (a fixed fingerprint reappearing auto-flips fixed→regressed). Without a
// dedicated filter test, a typo/omission in VALID_STATUSES would silently make
// ?status=regressed fall through the `$N IS NULL` guard and return the WHOLE
// unfiltered set instead of just the regressed groups — the exact failure mode
// the JS-after-LIMIT bug had for `fixed`. We create one genuinely-regressed
// group (upload → fix → re-upload) plus one open group in the same suite and
// assert the filter returns only the regressed one.

test("status=regressed returns only regressed groups (and not open ones)", async () => {
  const token = await registerOrg("errstatus-regressed");
  const suite = `errstatus-regressed-${Date.now()}`;

  // Two distinct error groups in one suite: one we will regress, one we leave open.
  await uploadFailingRun(token, suite, ["RegressMe", "StayOpen"]);
  const { rows: seeded } = await getErrors(token, `?suite=${encodeURIComponent(suite)}`);
  assert.equal(seeded.length, 2, "two distinct error messages → two groups");
  const regressMe = seeded.find((r) => r.error_message === "RegressMe")!;
  const stayOpen = seeded.find((r) => r.error_message === "StayOpen")!;

  // Drive RegressMe through fixed → regressed via the ingest recurrence hook:
  // mark it fixed, then re-upload the SAME fingerprint so it auto-reopens.
  assert.equal((await setStatus(token, regressMe.fingerprint, "fixed")).status, 200);
  await uploadFailingRun(token, suite, ["RegressMe"]);

  // Sanity: the suite view now shows RegressMe as regressed, StayOpen as open.
  const { rows: afterReupload } = await getErrors(token, `?suite=${encodeURIComponent(suite)}`);
  assert.equal(
    afterReupload.find((r) => r.fingerprint === regressMe.fingerprint)!.status,
    "regressed",
    "the re-uploaded fixed fingerprint auto-reopened to regressed"
  );
  assert.equal(
    afterReupload.find((r) => r.fingerprint === stayOpen.fingerprint)!.status,
    "open",
    "the never-fixed group stays open"
  );

  // The filter under test: ?status=regressed returns the regressed group and
  // excludes the open one. If 'regressed' were missing from VALID_STATUSES this
  // would return the unfiltered set (and so include StayOpen) → the assertion
  // catches the regression.
  const { rows: regressedRows, res } = await getErrors(token, "?status=regressed");
  assert.equal(res.status, 200);
  assert.ok(
    regressedRows.some((r) => r.fingerprint === regressMe.fingerprint),
    "the regressed group appears under status=regressed"
  );
  assert.ok(
    !regressedRows.some((r) => r.fingerprint === stayOpen.fingerprint),
    "the open group must NOT appear under status=regressed"
  );
  assert.ok(
    regressedRows.every((r) => r.status === "regressed"),
    "no non-regressed groups leak into status=regressed (the filter is active, not a no-op)"
  );
});

test("an unknown status value is ignored (returns the unfiltered set)", async () => {
  const token = await registerOrg("errstatus-unknown");
  const suite = `errstatus-unknown-${Date.now()}`;
  await uploadFailingRun(token, suite, ["UnknownStatusErr"]);

  const { rows: all } = await getErrors(token, `?suite=${encodeURIComponent(suite)}`);
  const { rows: bogus, res } = await getErrors(token, `?suite=${encodeURIComponent(suite)}&status=banana`);
  assert.equal(res.status, 200);
  assert.equal(bogus.length, all.length, "an invalid status is ignored rather than filtering everything out");
});

test("PATCH rejects an invalid status with 400", async () => {
  const token = await registerOrg("errstatus-patch");
  const res = await setStatus(token, "deadbeefdeadbeefdeadbeefdeadbeef", "not-a-status");
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /Invalid status/);
});

test("note_count reflects notes added to an error group", async () => {
  const token = await registerOrg("errstatus-notes");
  const suite = `errstatus-notes-${Date.now()}`;
  await uploadFailingRun(token, suite, ["NoteErr"]);

  const { rows } = await getErrors(token, `?suite=${encodeURIComponent(suite)}`);
  const fp = rows[0].fingerprint;
  assert.equal(rows[0].note_count, 0, "fresh group has no notes");

  // Empty body is rejected.
  const empty = await fetch(`${BASE}/errors/${fp}/notes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ body: "   " }),
  });
  assert.equal(empty.status, 400);

  const add = await fetch(`${BASE}/errors/${fp}/notes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ body: "investigating this one" }),
  });
  assert.equal(add.status, 201);

  const { rows: after } = await getErrors(token, `?suite=${encodeURIComponent(suite)}`);
  assert.equal(after[0].note_count, 1, "note_count picks up the added note");
});
