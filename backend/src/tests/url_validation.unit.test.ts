/**
 * Unit coverage for the validateRefUrl helper used to reject
 * `javascript:` / `data:` / `vbscript:` etc. before they're persisted
 * into manual_test_requirements.ref_url or
 * release_test_session_results.known_issue_ref.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRefUrl } from "../url-validation.js";

test("validateRefUrl: accepts http and https", () => {
  const a = validateRefUrl("http://example.com/foo");
  assert.deepEqual(a, { ok: true, value: "http://example.com/foo" });
  const b = validateRefUrl("https://acme.atlassian.net/browse/ABC-1");
  assert.equal(b.ok, true);
});

test("validateRefUrl: rejects javascript: payloads (the XSS gate)", () => {
  for (const v of [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "javascript://example.com/%0Aalert(1)",
  ]) {
    const r = validateRefUrl(v);
    assert.equal(r.ok, false, `must reject: ${v}`);
  }
});

test("validateRefUrl: rejects data:, vbscript:, file:, ftp:", () => {
  for (const v of [
    "data:text/html,<script>alert(1)</script>",
    "vbscript:alert(1)",
    "file:///etc/passwd",
    "ftp://example.com/x",
  ]) {
    assert.equal(validateRefUrl(v).ok, false, `must reject: ${v}`);
  }
});

test("validateRefUrl: rejects unknown / malformed inputs", () => {
  for (const v of [123, true, {}, [], "::not-a-url::"]) {
    assert.equal(validateRefUrl(v as unknown).ok, false);
  }
});

test("validateRefUrl: empty / null / undefined → ok with null value (column-clearing path)", () => {
  assert.deepEqual(validateRefUrl(null), { ok: true, value: null });
  assert.deepEqual(validateRefUrl(undefined), { ok: true, value: null });
  assert.deepEqual(validateRefUrl(""), { ok: true, value: null });
  assert.deepEqual(validateRefUrl("   "), { ok: true, value: null });
});

test("validateRefUrl: allowPlainKey accepts non-URL strings (e.g. JIRA-123)", () => {
  assert.deepEqual(
    validateRefUrl("JIRA-123", { allowPlainKey: true }),
    { ok: true, value: "JIRA-123" }
  );
  // Trims surrounding whitespace.
  assert.deepEqual(
    validateRefUrl("  ABC-1  ", { allowPlainKey: true }),
    { ok: true, value: "ABC-1" }
  );
});

test("validateRefUrl: allowPlainKey still rejects javascript: payloads", () => {
  // The presence of allowPlainKey must NOT widen the URL-scheme gate.
  // A `javascript:`-prefixed string parses as a URL (scheme present),
  // so the http-only check fires before the plain-key fallback.
  const r = validateRefUrl("javascript:alert(1)", { allowPlainKey: true });
  assert.equal(r.ok, false);
});
