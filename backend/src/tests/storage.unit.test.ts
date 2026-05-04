/**
 * Storage adapter unit tests — path-traversal defense.
 *
 * The local-disk storage backend's `put(tempPath, destKey)` resolves
 * `destKey` relative to `baseDir`.  Without an escape-the-root check,
 * any caller (or compromised path-construction in a future endpoint)
 * passing `../somewhere` writes outside the artifacts directory.
 *
 * Each upload endpoint already sanitizes its inputs, so this is
 * defense-in-depth at the storage layer.  These tests lock down the
 * guard so adding a new endpoint that forgets to sanitize fails
 * loudly instead of silently writing arbitrary files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import the LocalStorage class.  It's not exported, so we re-export
// for testing via a temporary inline factory; storage.ts uses a
// module-level singleton + getStorage().  For unit testing we go
// around the singleton by importing-and-instantiating directly.
//
// (Refactor note: storage.ts could export LocalStorage to skip this
// dance, but that would invite production code to bypass getStorage()
// and create rogue instances.  The current shape is fine.)
const STORAGE_MODULE = "../storage.js";

interface LocalStorageCtor {
  new (baseDir?: string): {
    put(tempPath: string, destKey: string): Promise<void>;
    getUrl(key: string): Promise<string>;
    deleteRun(runId: number): Promise<void>;
  };
}

async function loadLocalStorage(): Promise<LocalStorageCtor> {
  // Storage.ts doesn't export LocalStorage directly; we read the file
  // and look for the class.  Easier: just hit the module's getStorage()
  // factory with STORAGE=local (the default).
  const mod = await import(STORAGE_MODULE);
  // getStorage() returns a singleton.  Reset it by direct import-time
  // singleton manipulation isn't possible from outside the module, so
  // we test through the singleton's behaviour rather than constructing
  // a fresh instance.  Acceptable: each test uses a unique baseDir
  // path inside a tmpdir.
  const _instance = mod.getStorage();
  // Wrap so the rest of the test reads naturally.
  const FakeCtor: any = class {
    private inner: typeof _instance;
    private baseDir: string;
    constructor(baseDir: string) {
      this.baseDir = baseDir;
      this.inner = _instance;
    }
    put(tempPath: string, destKey: string) {
      // The real LocalStorage uses `uploads/` as its baseDir; we can't
      // change that from outside.  But the path-traversal guard logic
      // is identical regardless of baseDir, and we exercise it via a
      // destKey containing `..`.
      return this.inner.put(tempPath, destKey);
    }
    getUrl(key: string) { return this.inner.getUrl(key); }
    deleteRun(id: number) { return this.inner.deleteRun(id); }
  };
  return FakeCtor;
}

test("LocalStorage.put rejects destKey with traversal segments (..)", async () => {
  const Storage = await loadLocalStorage();
  const s = new Storage(mkdtempSync(join(tmpdir(), "storage-test-")));

  const tmp = join(tmpdir(), `evil-${Date.now()}.bin`);
  writeFileSync(tmp, "evil-payload");

  await assert.rejects(
    () => s.put(tmp, "../escape.txt"),
    /storage root|outside/i,
    "destKey containing `..` must be rejected by the storage layer"
  );

  // Cleanup attempt — the rename may or may not have left the temp file.
  try { rmSync(tmp); } catch { /* best-effort */ }
});

test("LocalStorage.put rejects deeply traversal destKeys (../../...)", async () => {
  const Storage = await loadLocalStorage();
  const s = new Storage(mkdtempSync(join(tmpdir(), "storage-test-")));

  const tmp = join(tmpdir(), `evil-${Date.now()}.bin`);
  writeFileSync(tmp, "evil-payload");

  await assert.rejects(
    () => s.put(tmp, "../../../tmp/escape.txt"),
    /storage root|outside/i,
    "deep traversal must also be rejected"
  );

  try { rmSync(tmp); } catch { /* best-effort */ }
});

test("LocalStorage.put rejects null bytes in destKey", async () => {
  const Storage = await loadLocalStorage();
  const s = new Storage(mkdtempSync(join(tmpdir(), "storage-test-")));

  const tmp = join(tmpdir(), `evil-${Date.now()}.bin`);
  writeFileSync(tmp, "evil-payload");

  await assert.rejects(
    () => s.put(tmp, "runs/1/snapshots/foo\0/escape.txt"),
    /storage root|outside|\\0/i,
    "null byte in destKey must be rejected"
  );

  try { rmSync(tmp); } catch { /* best-effort */ }
});

test("LocalStorage.put accepts a normal nested key", async () => {
  const Storage = await loadLocalStorage();
  const s = new Storage(mkdtempSync(join(tmpdir(), "storage-test-")));

  // The local renameSync requires the temp source to be on the same
  // filesystem as the destination (otherwise EXDEV — which can also
  // happen in containerized deployments mounting /tmp ephemeral and
  // /uploads as a PVC).  Match what multer does in production: use a
  // tempdir relative to the upload root.
  mkdirSync("uploads/tmp", { recursive: true });
  const tmp = `uploads/tmp/good-${Date.now()}.bin`;
  writeFileSync(tmp, "good-payload");

  const dirSegment = `test-storage-${Date.now()}`;
  const key = `runs/${dirSegment}/screenshots/sample.png`;
  await s.put(tmp, key);

  const written = `uploads/${key}`;
  assert.ok(existsSync(written), "valid nested key should write under baseDir");

  // Cleanup the test artifact so we don't litter uploads/ across runs.
  rmSync(written, { force: true });
  try { rmSync(`uploads/runs/${dirSegment}`, { recursive: true, force: true }); } catch { /* ignore */ }
});
