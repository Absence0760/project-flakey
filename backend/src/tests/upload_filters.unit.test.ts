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

import multer from "multer";

import { safeUnlinkTmp, wrapMulter } from "../upload-filters.js";
import { fixFilename } from "../routes/uploads.js";

// Multer decodes the multipart `filename` header as Latin-1, but browsers send
// it as UTF-8. To reproduce a real upload we take the original UTF-8 name,
// encode it to bytes, and re-read those bytes as Latin-1 — exactly the mangling
// fixFilename's first pass has to undo.
function asMulterReceives(originalName: string): string {
  return Buffer.from(originalName, "utf-8").toString("latin1");
}
const NUL = String.fromCharCode(0);

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

// ---------------------------------------------------------------------------
// fixFilename (routes/uploads.ts)
//
// Protects the reporter upload workflow: multer hands us a Latin-1-mangled
// filename, and fixFilename has to (1) recover the original UTF-8 characters
// and (2) sanitize away every path-traversal / null-byte trick before the
// name is joined into a storage key. These tests assert both passes.
// ---------------------------------------------------------------------------

test("fixFilename round-trips an accented name multer mangled to Latin-1", () => {
  assert.equal(fixFilename(asMulterReceives("café.png")), "café.png");
});

test("fixFilename round-trips an emoji name", () => {
  assert.equal(fixFilename(asMulterReceives("rocket\u{1F680}.png")), "rocket\u{1F680}.png");
});

test("fixFilename round-trips a CJK name", () => {
  assert.equal(fixFilename(asMulterReceives("スクリーンショット.png")), "スクリーンショット.png");
});

test("fixFilename leaves a plain ASCII name untouched", () => {
  assert.equal(fixFilename("login-failure.png"), "login-failure.png");
});

test("fixFilename strips an embedded NUL byte", () => {
  // A NUL injected mid-name (e.g. "shot\0evil.png") must be removed so it
  // can't truncate the path downstream at the syscall boundary.
  const out = fixFilename("shot" + NUL + "evil.png");
  assert.equal(out.includes(NUL), false);
  assert.equal(out, "shotevil.png");
});

test("fixFilename reduces a POSIX traversal path to its basename", () => {
  assert.equal(fixFilename("../../etc/passwd"), "passwd");
});

test("fixFilename reduces a Windows backslash path to its basename", () => {
  assert.equal(fixFilename("C:\\Users\\evil\\..\\shot.png"), "shot.png");
});

test("fixFilename strips traversal even when combined with a NUL byte", () => {
  assert.equal(fixFilename("../../etc/pas" + NUL + "swd"), "passwd");
});

test("fixFilename truncates a name longer than 200 chars", () => {
  const long = "a".repeat(250) + ".png";
  const out = fixFilename(long);
  assert.equal(out.length, 200);
  assert.equal(out, "a".repeat(200));
});

test("fixFilename falls back to the original string when the bytes aren't valid UTF-8", () => {
  // "ÿþ.png" as a JS string is U+00FF U+00FE — Buffer.from(_, "latin1") yields
  // bytes 0xFF 0xFE, which is not a legal UTF-8 sequence. The fatal decoder
  // throws and the helper must fall back to the original string rather than
  // throw out of the request handler.
  const name = "ÿþ.png";
  let out: string | undefined;
  assert.doesNotThrow(() => { out = fixFilename(name); });
  assert.equal(out, "ÿþ.png");
});

// ---------------------------------------------------------------------------
// wrapMulter (upload-filters.ts)
//
// Translates multer's errors into clean, actionable HTTP responses. The
// load-bearing case: LIMIT_UNEXPECTED_FILE is raised BOTH for an unknown
// field name AND for a known field that overflowed its maxCount, with the
// same "Unexpected field" message. The field caps let us tell those apart
// so a reporter that ships >500 snapshots learns it hit the count cap
// instead of being told its (registered) field is unexpected.
// ---------------------------------------------------------------------------

const FIELD_CAPS = { screenshots: 100, videos: 100, snapshots: 500 };

function runWrapMulter(err: unknown, fieldCaps?: Record<string, number>) {
  let statusCode = 0;
  let body: { error?: string } | undefined;
  let nextCalled = false;
  const res = {
    status(c: number) { statusCode = c; return this; },
    json(b: { error?: string }) { body = b; return this; },
  } as never;
  // Stand-in middleware that immediately yields `err` to wrapMulter's callback.
  const mw = ((_req: unknown, _res: unknown, cb: (e: unknown) => void) => cb(err)) as never;
  wrapMulter(mw, fieldCaps)({} as never, res, () => { nextCalled = true; });
  return { statusCode, body, nextCalled };
}

test("wrapMulter rewrites an over-cap known field into an actionable 413", () => {
  // The 501st `snapshots` file: multer says "Unexpected field"; we must
  // name the field and its limit instead.
  const { statusCode, body, nextCalled } = runWrapMulter(
    new multer.MulterError("LIMIT_UNEXPECTED_FILE", "snapshots"),
    FIELD_CAPS,
  );
  assert.equal(nextCalled, false);
  assert.equal(statusCode, 413);
  assert.match(body!.error!, /Too many files in "snapshots"/);
  assert.match(body!.error!, /max 500/);
});

test("wrapMulter keeps 'unexpected field' for a genuinely unregistered field, and lists the allowed ones", () => {
  const { statusCode, body } = runWrapMulter(
    new multer.MulterError("LIMIT_UNEXPECTED_FILE", "bogus"),
    FIELD_CAPS,
  );
  assert.equal(statusCode, 400);
  assert.match(body!.error!, /Unexpected upload field "bogus"/);
  assert.match(body!.error!, /screenshots, videos, snapshots/);
});

test("wrapMulter maps a file-size overflow to 413", () => {
  const { statusCode, body } = runWrapMulter(
    new multer.MulterError("LIMIT_FILE_SIZE", "videos"),
    FIELD_CAPS,
  );
  assert.equal(statusCode, 413);
  assert.ok(typeof body!.error === "string" && body!.error.length > 0);
});

test("wrapMulter surfaces a non-multer error as a clean 400", () => {
  const { statusCode, body } = runWrapMulter(new Error("boom"), FIELD_CAPS);
  assert.equal(statusCode, 400);
  assert.equal(body!.error, "boom");
});

test("wrapMulter calls next() and sends no response when there is no error", () => {
  const { statusCode, nextCalled } = runWrapMulter(null, FIELD_CAPS);
  assert.equal(nextCalled, true);
  assert.equal(statusCode, 0);
});
