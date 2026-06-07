import { test, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { flakeySnapshots } from "../plugin.ts";

/**
 * The snapshots plugin streams each test's bundle to a live run and, by
 * default, unlinks the local .json.gz on success to bound disk use. When
 * `outputDir` doubles as a persistent corpus (read by a selector-reconcile
 * tool), that unlink would erode the corpus across live runs — so
 * `unlinkAfterStream: false` must keep the local file after a successful
 * stream. These pin both branches.
 *
 * We drive the plugin's `flakey:saveSnapshot` task directly: a fake `on`
 * captures the task map, env vars + a stubbed global fetch make
 * maybeStreamUpload "succeed", and we assert the file's presence afterwards.
 */

function captureTask(opts: Parameters<typeof flakeySnapshots>[2]) {
  let saveSnapshot: ((bundle: unknown) => Promise<{ saved: boolean; streamed?: boolean }>) | undefined;
  const on = (event: string, arg: Record<string, unknown>) => {
    if (event === "task" && arg && typeof arg["flakey:saveSnapshot"] === "function") {
      saveSnapshot = arg["flakey:saveSnapshot"] as typeof saveSnapshot;
    }
  };
  flakeySnapshots(on, { env: {} }, opts);
  if (!saveSnapshot) throw new Error("flakey:saveSnapshot task was not registered");
  return saveSnapshot;
}

function makeBundle() {
  return {
    version: 1 as const,
    testTitle: "Example Tests UI keep-after-stream",
    specFile: "cypress/e2e/example.feature",
    steps: [{ index: 0, commandName: "get", commandMessage: "body", timestamp: 1, html: "<html></html>", scrollX: 0, scrollY: 0 }],
    viewportWidth: 1000,
    viewportHeight: 660,
  };
}

let outputDir: string;
const realFetch = globalThis.fetch;
const savedEnv = { url: process.env.FLAKEY_API_URL, key: process.env.FLAKEY_API_KEY, run: process.env.FLAKEY_LIVE_RUN_ID };

beforeEach(() => {
  outputDir = mkdtempSync(join(tmpdir(), "flakey-snap-"));
  // Make maybeStreamUpload take the live path: all three env vars set.
  process.env.FLAKEY_API_URL = "http://localhost:3000";
  process.env.FLAKEY_API_KEY = "fk_test_key";
  process.env.FLAKEY_LIVE_RUN_ID = "1234";
  // Stub fetch so the "upload" succeeds without a backend.
  globalThis.fetch = (async () => ({ ok: true })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.FLAKEY_API_URL = savedEnv.url; process.env.FLAKEY_API_KEY = savedEnv.key; process.env.FLAKEY_LIVE_RUN_ID = savedEnv.run;
  if (savedEnv.url === undefined) delete process.env.FLAKEY_API_URL;
  if (savedEnv.key === undefined) delete process.env.FLAKEY_API_KEY;
  if (savedEnv.run === undefined) delete process.env.FLAKEY_LIVE_RUN_ID;
  rmSync(outputDir, { recursive: true, force: true });
});

test("unlinkAfterStream:false keeps the local .json.gz after a successful stream (corpus preserved)", async () => {
  const saveSnapshot = captureTask({ outputDir, unlinkAfterStream: false });
  const res = await saveSnapshot(makeBundle());
  assert.equal(res.saved, true);
  assert.equal(res.streamed, true);
  const files = readdirSync(outputDir).filter((f) => f.endsWith(".json.gz"));
  assert.equal(files.length, 1, "the corpus file must remain on disk after streaming");
});

test("default (unlinkAfterStream omitted) removes the local .json.gz after a successful stream", async () => {
  const saveSnapshot = captureTask({ outputDir });
  const res = await saveSnapshot(makeBundle());
  assert.equal(res.streamed, true);
  const files = readdirSync(outputDir).filter((f) => f.endsWith(".json.gz"));
  assert.equal(files.length, 0, "default behavior reaps the local file to bound disk use");
});

test("when streaming does NOT happen (no live run id), the file is retained regardless of unlinkAfterStream", async () => {
  delete process.env.FLAKEY_LIVE_RUN_ID;
  const saveSnapshot = captureTask({ outputDir });
  const res = await saveSnapshot(makeBundle());
  assert.equal(res.saved, true);
  assert.notEqual(res.streamed, true);
  const files = readdirSync(outputDir).filter((f) => f.endsWith(".json.gz"));
  assert.equal(files.length, 1, "no stream → end-of-run batch needs the file, so it stays");
});
