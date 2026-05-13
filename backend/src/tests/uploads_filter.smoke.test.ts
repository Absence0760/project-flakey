/**
 * Boundary tests for POST /runs/upload.
 *
 * Pins two security gates added in the audit fix:
 *
 *   1. fileFilter rejects SVG / SVGZ / HTML attachments — without this
 *      a reporter could upload `xss.html` and (in local-disk mode) the
 *      `/uploads/...` express.static handler would serve it back with
 *      Content-Type: text/html, executing inside the dashboard origin.
 *      S3 mode is covered by guessContentType's octet-stream fallback,
 *      but the boundary check makes both modes consistent.
 *
 *   2. Multer errors surface as a clean 400 (or 413 for size limits),
 *      not the default 500 from Express's fallback handler. A reporter
 *      seeing 500 has no way to tell "the server is broken" from
 *      "you sent a forbidden type"; a 400 makes the contract clear and
 *      stops audit-log noise from rejected requests.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3987;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let token: string;

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

before(async () => {
  server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "uploads-filter-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  const email = `uploads-filter+${Date.now()}@test.local`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email, password: "testpass123", name: "UF",
      org_name: `UploadFilterOrg-${Date.now()}`,
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
});

function buildPayload(suite: string) {
  return JSON.stringify({
    meta: {
      suite_name: suite,
      branch: "main",
      commit_sha: "deadbeef",
      ci_run_id: `ci-uf-${Date.now()}`,
      started_at: "2026-05-13T00:00:00Z",
      finished_at: "2026-05-13T00:00:30Z",
      reporter: "mochawesome",
    },
    stats: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0, duration_ms: 30000 },
    specs: [{
      file_path: "login.cy.ts",
      title: "login",
      stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration_ms: 30000 },
      tests: [{ title: "ok", full_title: "Login > ok", status: "passed", duration_ms: 100, screenshot_paths: [] }],
    }],
  });
}

test("POST /runs/upload rejects an SVG screenshot at the multer fileFilter (XSS-via-attachment gate)", async () => {
  const fd = new FormData();
  fd.append("payload", buildPayload(`uf-svg-${Date.now()}`));
  // SVG would be served as image/svg+xml under express.static and run
  // <script>; storage.ts forces octet-stream as a backup, but the
  // boundary should reject the upload outright.
  fd.append(
    "screenshots",
    new Blob(["<svg onload=alert(1)/>"], { type: "image/svg+xml" }),
    "evil.svg",
  );

  const res = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });

  assert.equal(res.status, 400, "SVG upload must be rejected with a 400 (not silently accepted, not a 500)");
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /not allowed/i, "error message must name the rejection reason");
});

test("POST /runs/upload rejects an HTML screenshot upload (cannot smuggle xss.html into the artifact bucket)", async () => {
  const fd = new FormData();
  fd.append("payload", buildPayload(`uf-html-${Date.now()}`));
  fd.append(
    "screenshots",
    new Blob(["<html><script>alert(1)</script></html>"], { type: "text/html" }),
    "xss.html",
  );

  const res = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });

  assert.equal(res.status, 400, "HTML upload must be rejected with a 400");
});

test("POST /runs/upload rejects a file whose MIME claims SVG even if extension is .png (defence-in-depth)", async () => {
  // The fileFilter checks BOTH extension and mimetype because a
  // reporter that controls multipart headers can lie about either.
  const fd = new FormData();
  fd.append("payload", buildPayload(`uf-mime-${Date.now()}`));
  fd.append(
    "screenshots",
    new Blob(["<svg/>"], { type: "image/svg+xml" }),
    "looks-safe.png",
  );

  const res = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });

  assert.equal(res.status, 400, "MIME-claim mismatch must NOT bypass the SVG filter");
});

test("POST /runs/upload accepts a regular PNG (filter doesn't break the happy path)", async () => {
  const fd = new FormData();
  fd.append("payload", buildPayload(`uf-png-${Date.now()}`));
  // PNG magic bytes — the contents don't actually need to be a real
  // image for the upload to succeed; this just sanity-checks that the
  // filter rejection is targeted and not blanket-blocking everything.
  fd.append(
    "screenshots",
    new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: "image/png" }),
    "screen.png",
  );

  const res = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });

  assert.ok(res.ok, `regular PNG must upload cleanly; got ${res.status}: ${await res.text().catch(() => "")}`);
});
