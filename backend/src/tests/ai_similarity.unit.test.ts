/**
 * AI similarity scoring unit tests.
 *
 * computeSimilarity() drives the "find similar historical failures" panel.
 * It's a pure tokens-Jaccard function over normalized text, so it has no
 * external dependencies, but a regression in the normalization step would
 * silently change clustering behaviour for every failure in the database.
 *
 * The function takes two error-message-like strings and returns a value
 * in [0, 1].  These tests pin its current contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSimilarity, parseJSON } from "../ai.js";

// ── Identity / empty ─────────────────────────────────────────────────────

test("computeSimilarity: identical strings score 1.0", () => {
  assert.equal(computeSimilarity("foo bar baz", "foo bar baz"), 1);
});

test("computeSimilarity: both empty → 0 (avoid NaN from 0/0)", () => {
  assert.equal(computeSimilarity("", ""), 0);
});

test("computeSimilarity: one empty → 0", () => {
  assert.equal(computeSimilarity("", "anything"), 0);
  assert.equal(computeSimilarity("anything", ""), 0);
});

test("computeSimilarity: only-punctuation tokenizes to nothing → 0", () => {
  // After stripping non-alphanumeric, both become empty token sets.
  assert.equal(computeSimilarity("!!!", "??!"), 0);
});

// ── Disjoint vs overlapping ──────────────────────────────────────────────

test("computeSimilarity: completely disjoint strings score 0", () => {
  assert.equal(computeSimilarity("alpha beta", "gamma delta"), 0);
});

test("computeSimilarity: full overlap regardless of order is 1.0", () => {
  assert.equal(computeSimilarity("a b c", "c a b"), 1);
});

test("computeSimilarity: half overlap scores around 0.5", () => {
  // {a, b} vs {a, c} → intersection 1, max-size 2 → 0.5
  assert.equal(computeSimilarity("a b", "a c"), 0.5);
});

// ── Normalization ────────────────────────────────────────────────────────

test("computeSimilarity: case-insensitive — 'ERROR foo' ≈ 'error FOO'", () => {
  assert.equal(computeSimilarity("ERROR foo", "error FOO"), 1);
});

test("computeSimilarity: punctuation is stripped before tokenizing", () => {
  // "Error: timeout!" → "error timeout"
  // "error timeout"   → "error timeout"
  assert.equal(computeSimilarity("Error: timeout!", "error timeout"), 1);
});

test("computeSimilarity: digits are preserved as part of tokens", () => {
  // /[^a-z0-9\s]/ strips non-alphanumeric, NOT digits.  So "code 500"
  // tokenizes as ["code", "500"], not just ["code"].  This matters for
  // clustering by HTTP status / error code.
  assert.equal(computeSimilarity("code 500", "code 500"), 1);
  assert.ok(computeSimilarity("code 500", "code 404") < 1, "different codes should differ");
  assert.ok(computeSimilarity("code 500", "code 404") > 0, "shared 'code' token should score > 0");
});

// ── Realistic error messages ─────────────────────────────────────────────

test("computeSimilarity: two ENOENT errors with different paths cluster high", () => {
  // The classic flaky-failure clustering target.
  const a = "Error: ENOENT: no such file or directory, open '/tmp/abc.txt'";
  const b = "Error: ENOENT: no such file or directory, open '/tmp/xyz.txt'";
  const score = computeSimilarity(a, b);
  assert.ok(score > 0.5, `ENOENT errors should cluster (got ${score})`);
  assert.ok(score < 1, "different paths should not collapse to identical");
});

test("computeSimilarity: TypeError vs ENOENT cluster low", () => {
  const a = "TypeError: Cannot read property 'foo' of undefined at Object.<anonymous>";
  const b = "Error: ENOENT: no such file or directory, open '/tmp/abc.txt'";
  const score = computeSimilarity(a, b);
  assert.ok(score < 0.5, `unrelated errors should not over-cluster (got ${score})`);
});

test("computeSimilarity: assertion-style errors with same expectation cluster high", () => {
  const a = "AssertionError: expected 200 to equal 201";
  const b = "AssertionError: expected 200 to equal 201";
  assert.equal(computeSimilarity(a, b), 1);
});

// ── Output range invariant ───────────────────────────────────────────────

test("computeSimilarity: result is always in [0, 1]", () => {
  const cases: [string, string][] = [
    ["", ""],
    ["a", "a"],
    ["a b c d e", "a"],
    ["lorem ipsum dolor sit amet", "consectetur adipiscing elit"],
    ["error code 500 timeout", "code 500 error"],
  ];
  for (const [a, b] of cases) {
    const s = computeSimilarity(a, b);
    assert.ok(s >= 0 && s <= 1, `similarity ${s} for (${a}, ${b}) is outside [0,1]`);
  }
});

// ── Symmetry ─────────────────────────────────────────────────────────────

test("computeSimilarity: is symmetric — sim(a,b) === sim(b,a)", () => {
  // Important for clustering: the order of comparison must not change
  // the score, otherwise UI ordering depends on which row was queried
  // first.
  const pairs: [string, string][] = [
    ["foo", "foo bar"],
    ["error 500", "code 500 error timeout"],
    ["", "anything"],
  ];
  for (const [a, b] of pairs) {
    const ab = computeSimilarity(a, b);
    const ba = computeSimilarity(b, a);
    assert.equal(ab, ba, `asymmetric: sim(${a}, ${b})=${ab}, sim(${b}, ${a})=${ba}`);
  }
});

// ── parseJSON ────────────────────────────────────────────────────────────
// AI responses that "should" be raw JSON in practice arrive wrapped in
// markdown fences, sometimes with surrounding prose despite explicit
// "no markdown fences" instructions in the prompt.  parseJSON is the
// last line of defence; bugs here silently fall back to the default
// object and the user sees boring "Unable to determine" placeholder
// text instead of the real classification.

const FALLBACK = { rootCause: "fallback", severity: "low" };

test("parseJSON: parses raw JSON without markdown fences", () => {
  const out = parseJSON<typeof FALLBACK>('{"rootCause":"timing","severity":"high"}', FALLBACK);
  assert.equal(out.rootCause, "timing");
  assert.equal(out.severity, "high");
});

test("parseJSON: strips ```json fence prefix and trailing ```", () => {
  const text = '```json\n{"rootCause":"x","severity":"low"}\n```';
  const out = parseJSON<typeof FALLBACK>(text, FALLBACK);
  assert.equal(out.rootCause, "x");
});

test("parseJSON: strips bare ``` fence (no language tag)", () => {
  const text = '```\n{"rootCause":"x","severity":"low"}\n```';
  const out = parseJSON<typeof FALLBACK>(text, FALLBACK);
  assert.equal(out.rootCause, "x");
});

test("parseJSON: malformed JSON returns the fallback verbatim", () => {
  // Important contract: callers rely on getting back the *exact*
  // fallback object so downstream rendering doesn't blow up.
  const out = parseJSON<typeof FALLBACK>("{not valid json", FALLBACK);
  assert.deepEqual(out, FALLBACK);
});

test("parseJSON: empty string returns fallback", () => {
  assert.deepEqual(parseJSON<typeof FALLBACK>("", FALLBACK), FALLBACK);
});

test("parseJSON: whitespace-only returns fallback (no spurious match)", () => {
  assert.deepEqual(parseJSON<typeof FALLBACK>("   \n   ", FALLBACK), FALLBACK);
});

test("parseJSON: handles JSON with surrounding whitespace inside the fences", () => {
  const text = '```json\n\n  {"rootCause":"y","severity":"medium"}  \n\n```';
  const out = parseJSON<typeof FALLBACK>(text, FALLBACK);
  assert.equal(out.rootCause, "y");
});
