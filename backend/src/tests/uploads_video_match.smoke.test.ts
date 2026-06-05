/**
 * Regression: a multi-spec upload must match each video to its own spec, not
 * apply the last-uploaded video to every test.
 *
 * Cypress writes one video per spec, named after the spec file
 * (login.cy.ts.mp4). The upload handler used to keep a single "last video
 * wins" path and stamp it onto every test in the run — stranding the other
 * videos and mislabelling every test. This uploads two specs with two videos
 * and asserts each spec's tests carry their own video.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const PORT = 3995;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let token: string;
let runId: number;

async function waitForHealth(maxMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* retry */ }
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
      JWT_SECRET: "videomatch-test-secret",
      ALLOW_REGISTRATION: "true",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForHealth();

  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `videomatch+${Date.now()}@test.local`,
      password: "testpass123",
      name: "VideoMatch",
      org_name: `VideoMatchOrg-${Date.now()}`,
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
  token = ((await reg.json()) as { token: string }).token;

  const fd = new FormData();
  fd.append("payload", JSON.stringify({
    meta: {
      suite_name: `videomatch-${Date.now()}`,
      branch: "main",
      commit_sha: "deadbeef",
      ci_run_id: `ci-videomatch-${Date.now()}`,
      started_at: "2026-04-10T00:00:00Z",
      finished_at: "2026-04-10T00:00:30Z",
      reporter: "mochawesome",
    },
    stats: { total: 2, passed: 2, failed: 0, skipped: 0, pending: 0, duration_ms: 30000 },
    specs: [
      {
        file_path: "login.cy.ts",
        title: "login",
        stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration_ms: 15000 },
        tests: [{ title: "logs in", full_title: "login > logs in", status: "passed", duration_ms: 100, screenshot_paths: [] }],
      },
      {
        file_path: "checkout.cy.ts",
        title: "checkout",
        stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration_ms: 15000 },
        tests: [{ title: "buys", full_title: "checkout > buys", status: "passed", duration_ms: 100, screenshot_paths: [] }],
      },
    ],
  }));
  // Two videos, one per spec, named after the spec file (Cypress convention).
  fd.append("videos", new Blob([Buffer.from("fake-mp4-login")], { type: "video/mp4" }), "login.cy.ts.mp4");
  fd.append("videos", new Blob([Buffer.from("fake-mp4-checkout")], { type: "video/mp4" }), "checkout.cy.ts.mp4");

  const up = await fetch(`${BASE}/runs/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!up.ok) throw new Error(`upload failed: ${up.status} ${await up.text().catch(() => "")}`);
  runId = ((await up.json()) as { id: number }).id;
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

test("each spec's tests carry their own video, not the last one uploaded", async () => {
  const detail = await (await fetch(`${BASE}/runs/${runId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json() as { specs: Array<{ file_path: string; tests: Array<{ full_title: string; video_path: string | null }> }> };

  const byFile = new Map(detail.specs.map((s) => [s.file_path, s]));
  const login = byFile.get("login.cy.ts");
  const checkout = byFile.get("checkout.cy.ts");
  assert.ok(login && checkout, "both specs should be present");

  assert.match(login!.tests[0].video_path ?? "", /login\.cy\.ts\.mp4$/, "login test got the wrong video");
  assert.match(checkout!.tests[0].video_path ?? "", /checkout\.cy\.ts\.mp4$/, "checkout test got the wrong video");
});
