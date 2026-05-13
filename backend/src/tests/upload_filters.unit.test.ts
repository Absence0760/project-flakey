/**
 * Unit tests for upload-filters.ts.
 *
 * Pins the safeUnlinkTmp bounds-check that defends against a hypothetical
 * change in our multer storage engine — if someone ever swapped multer's
 * dest-with-random-name strategy for a custom engine that honoured a
 * client-controlled filename, this guard would still refuse to unlink
 * anything outside uploads/tmp/.
 *
 * CodeQL flagged the unguarded rmSync(file.path) sites as
 * js/path-injection because the dataflow runs from req.file (user-
 * tainted) → file.path → rmSync. The helper introduces a runtime
 * bounds check that both closes the alert and makes the guarantee
 * a code-level invariant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { safeUnlinkTmp } from "../upload-filters.js";

test("safeUnlinkTmp removes a file that lives inside uploads/tmp/", () => {
  mkdirSync("uploads/tmp", { recursive: true });
  const target = path.resolve("uploads/tmp", `unit-${Date.now()}-${process.pid}.bin`);
  writeFileSync(target, "x");
  assert.equal(existsSync(target), true);
  safeUnlinkTmp(target);
  assert.equal(existsSync(target), false);
});

test("safeUnlinkTmp refuses a path that escapes uploads/tmp/ via ..", () => {
  // Drop a sentinel OUTSIDE uploads/tmp that we don't want deleted.
  const outsideDir = mkdtempSync(path.join(tmpdir(), "safeunlink-"));
  const sentinel = path.join(outsideDir, "leave-me-alone.txt");
  writeFileSync(sentinel, "important");

  try {
    // Try to traverse out of uploads/tmp into the sentinel's directory.
    const escapingPath = path.join("uploads/tmp", "..", "..", path.relative(process.cwd(), sentinel));
    safeUnlinkTmp(escapingPath);
    // Sentinel must still exist — the helper rejected the traversal.
    assert.equal(existsSync(sentinel), true);
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("safeUnlinkTmp refuses an absolute path outside uploads/tmp/", () => {
  const outsideDir = mkdtempSync(path.join(tmpdir(), "safeunlink-"));
  const sentinel = path.join(outsideDir, "absolute-sentinel.txt");
  writeFileSync(sentinel, "important");

  try {
    safeUnlinkTmp(sentinel);
    assert.equal(existsSync(sentinel), true);
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("safeUnlinkTmp is a no-op when the file is already gone", () => {
  mkdirSync("uploads/tmp", { recursive: true });
  const target = path.resolve("uploads/tmp", `gone-${Date.now()}-${process.pid}.bin`);
  // Never created — must not throw.
  assert.doesNotThrow(() => safeUnlinkTmp(target));
});

test("safeUnlinkTmp refuses a sibling-prefix path (uploads/tmpfoo/...)", () => {
  // Without the trailing path.sep on UPLOAD_TMP_ROOT, a path like
  // `uploads/tmpfoo/x` would startsWith() the root by string-prefix
  // and bypass the gate. The helper appends path.sep specifically to
  // close that hole — pin it.
  const outsideDir = path.resolve("uploads/tmpfoo");
  mkdirSync(outsideDir, { recursive: true });
  const sentinel = path.join(outsideDir, "sibling.txt");
  writeFileSync(sentinel, "important");

  try {
    safeUnlinkTmp(sentinel);
    assert.equal(existsSync(sentinel), true);
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
  }
});
