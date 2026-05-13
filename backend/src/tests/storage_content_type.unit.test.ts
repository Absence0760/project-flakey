/**
 * Storage Content-Type guessing — pinned because the SVG / SVGZ rule
 * is a security boundary, not a cosmetic mapping.
 *
 * Browsers execute <script> inside SVG when the response is served as
 * `image/svg+xml`. An attached "screenshot.svg" served back inline
 * would become a stored XSS the moment a user opened the attachment
 * link. storage.ts forces svg/svgz to application/octet-stream so the
 * browser downloads instead of rendering, regardless of the source
 * file's actual content.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { guessContentType } from "../storage.js";

test("guessContentType returns image/png for .png", () => {
  assert.equal(guessContentType("runs/1/screenshots/foo.png"), "image/png");
});

test("guessContentType returns image/jpeg for .jpg and .jpeg", () => {
  assert.equal(guessContentType("foo.jpg"), "image/jpeg");
  assert.equal(guessContentType("foo.jpeg"), "image/jpeg");
});

test("guessContentType returns video/mp4 for .mp4 and video/webm for .webm", () => {
  assert.equal(guessContentType("foo.mp4"), "video/mp4");
  assert.equal(guessContentType("foo.webm"), "video/webm");
});

test("guessContentType returns application/gzip for .gz and application/json for .json", () => {
  assert.equal(guessContentType("snap.json.gz"), "application/gzip");
  assert.equal(guessContentType("payload.json"), "application/json");
});

test("guessContentType FORCES svg / svgz to application/octet-stream (XSS gate)", () => {
  // image/svg+xml would let the browser execute <script> inside the
  // SVG. octet-stream forces a download instead.
  assert.equal(guessContentType("evil.svg"), "application/octet-stream");
  assert.equal(guessContentType("evil.svgz"), "application/octet-stream");
  // Case-insensitive — extensions get lowercased before the switch.
  assert.equal(guessContentType("EVIL.SVG"), "application/octet-stream");
  // Long-path forms work too.
  assert.equal(
    guessContentType("evidence/42/7/1234567890-payload.svg"),
    "application/octet-stream",
  );
});

test("guessContentType returns application/octet-stream for unknown / no extension", () => {
  assert.equal(guessContentType("README"), "application/octet-stream");
  assert.equal(guessContentType("foo.exe"), "application/octet-stream");
  assert.equal(guessContentType("foo.bin"), "application/octet-stream");
});
