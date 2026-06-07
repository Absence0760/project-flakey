import { test, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeHandoff, releaseHandoff } from "../handoff.ts";

/**
 * The run-id handoff is shared by concurrent `cypress run` invocations that
 * may share higher ancestor pids. These pin the collision policy:
 *   - claim=true (per-ancestor pid files): first-writer-wins — a sibling must
 *     never clobber the mapping the first run established at a shared pid.
 *   - claim=false (singleton fallback): last-writer-wins, as before.
 *   - symlink defence: a planted symlink is unlinked (link removed, not its
 *     target) and replaced with a fresh regular file, both modes.
 *   - releaseHandoff only removes files the calling run still owns.
 */

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "flakey-handoff-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("writeHandoff creates the file when absent (both modes)", () => {
  const p = join(dir, "live-run-id-100");
  writeHandoff(p, "501", true);
  assert.equal(readFileSync(p, "utf8"), "501");
});

test("claim=true is first-writer-wins: a sibling does NOT clobber an established mapping", () => {
  const p = join(dir, "live-run-id-shared");
  writeHandoff(p, "501", true);   // first run claims the shared-ancestor pid
  writeHandoff(p, "502", true);   // sibling run must not overwrite it
  assert.equal(readFileSync(p, "utf8"), "501", "first writer's run id must survive");
});

test("claim=false is last-writer-wins: the singleton pointer updates", () => {
  const p = join(dir, "latest-run-id");
  writeHandoff(p, "501", false);
  writeHandoff(p, "502", false);
  assert.equal(readFileSync(p, "utf8"), "502", "singleton fallback tracks the latest writer");
});

test("symlink defence: a planted symlink is removed (target untouched) and replaced with a regular file", () => {
  const sentinel = join(dir, "sentinel.txt");
  writeFileSync(sentinel, "DO-NOT-OVERWRITE");
  const p = join(dir, "live-run-id-attacked");
  symlinkSync(sentinel, p); // attacker plants a symlink at the predictable path

  writeHandoff(p, "777", true);

  assert.equal(lstatSync(p).isSymbolicLink(), false, "the symlink must be replaced by a regular file");
  assert.equal(readFileSync(p, "utf8"), "777", "our run id is written to the fresh regular file");
  assert.equal(readFileSync(sentinel, "utf8"), "DO-NOT-OVERWRITE", "the symlink target must be untouched");
});

test("releaseHandoff removes a file only when it still holds our run id", () => {
  const p = join(dir, "live-run-id-200");
  writeHandoff(p, "555", true);

  releaseHandoff(p, "999");                 // not ours — must NOT delete
  assert.equal(existsSync(p), true, "a sibling's mapping must survive our cleanup");

  releaseHandoff(p, "555");                 // ours — delete
  assert.equal(existsSync(p), false, "our own mapping is cleaned up");
});

test("releaseHandoff is a no-op on a missing file", () => {
  assert.doesNotThrow(() => releaseHandoff(join(dir, "nope"), "1"));
});
