/**
 * Email-normalization unit tests.
 *
 * normalizeEmail() is the single canonicaliser used at every email-
 * touching entry point in auth (register, login, forgot-password,
 * resend-verification, invite create, invite resolve).  It feeds into
 * `WHERE LOWER(email) = $1` lookups, so any drift between this helper's
 * output and `LOWER()` semantics in Postgres breaks login or duplicate
 * detection silently.
 *
 * Bug history that motivated the helper:
 *   - User registered alice@x.com, typed Alice@X.com on login → 401.
 *   - Two registrations with effectively-same email slipped past the
 *     UNIQUE constraint (alice@x.com vs Alice@X.com → two rows, two
 *     password hashes, only one of them ever logs in).
 *   - Forgot-password lookup for the inviter's casing returned "no
 *     row" and the user never got the reset email.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmail } from "../auth.js";

// ── Identity / casing ────────────────────────────────────────────────────

test("normalizeEmail: already-lowercase passes through unchanged", () => {
  assert.equal(normalizeEmail("alice@example.com"), "alice@example.com");
});

test("normalizeEmail: uppercase domain is lowercased", () => {
  assert.equal(normalizeEmail("alice@EXAMPLE.COM"), "alice@example.com");
});

test("normalizeEmail: uppercase local-part is lowercased", () => {
  assert.equal(normalizeEmail("ALICE@example.com"), "alice@example.com");
});

test("normalizeEmail: mixed-case fully canonicalises", () => {
  assert.equal(normalizeEmail("Alice.Smith@Sub.Example.Com"), "alice.smith@sub.example.com");
});

// ── Whitespace ───────────────────────────────────────────────────────────

test("normalizeEmail: leading/trailing whitespace is trimmed", () => {
  // Real-world: email autofill on mobile sometimes appends a stray
  // space.  Without trim() the user gets "no such account" on login
  // for what looks like the right email.
  assert.equal(normalizeEmail("  alice@example.com  "), "alice@example.com");
});

test("normalizeEmail: tab and newline are trimmed (any whitespace, not just spaces)", () => {
  assert.equal(normalizeEmail("\talice@example.com\n"), "alice@example.com");
});

// ── Defensive / non-string input ────────────────────────────────────────

test("normalizeEmail: null returns empty string", () => {
  // Many call-sites do `if (!email) ...` after normalize. Returning ""
  // funnels nullish input into the existing empty-check guard rather
  // than throwing on .trim().
  assert.equal(normalizeEmail(null), "");
});

test("normalizeEmail: undefined returns empty string", () => {
  assert.equal(normalizeEmail(undefined), "");
});

test("normalizeEmail: non-string input returns empty string (defensive)", () => {
  // req.body.email may be a number/array/object if a caller posts JSON
  // weirdly.  Returning "" keeps the validation flow clean.
  assert.equal(normalizeEmail(42 as unknown as string), "");
  assert.equal(normalizeEmail([] as unknown as string), "");
  assert.equal(normalizeEmail({} as unknown as string), "");
});

test("normalizeEmail: empty string round-trips as empty string", () => {
  assert.equal(normalizeEmail(""), "");
});

test("normalizeEmail: whitespace-only normalises to empty (so empty-check guards still catch it)", () => {
  assert.equal(normalizeEmail("   "), "");
});

// ── Idempotence ──────────────────────────────────────────────────────────

test("normalizeEmail: idempotent — normalize(normalize(x)) === normalize(x)", () => {
  // Important: SQL queries match on `LOWER(email) = $1` where $1 is the
  // helper's output.  If the helper produces something LOWER() wouldn't
  // produce, lookups silently miss.  Idempotence is a weaker but cheap
  // proof the function is in canonical form.
  const inputs = [
    "alice@x.com",
    "ALICE@X.COM",
    "  Alice@X.Com  ",
    "user+tag@domain.io",
    "",
    "   ",
  ];
  for (const i of inputs) {
    const once = normalizeEmail(i);
    const twice = normalizeEmail(once);
    assert.equal(once, twice, `not idempotent for ${JSON.stringify(i)}: ${once} → ${twice}`);
  }
});

// ── Equivalence with SQL LOWER() ────────────────────────────────────────

test("normalizeEmail: output matches what Postgres LOWER() would produce for ASCII input", () => {
  // The query layer uses `LOWER(email) = $1`. If the JS helper's case
  // mapping ever diverges from Postgres's (e.g., over Unicode locale),
  // lookups fail silently.  We cover only ASCII here since Postgres's
  // LOWER() uses the database collation for non-ASCII.
  const cases = [
    ["A@B.COM", "a@b.com"],
    ["test+TAG@DOMAIN.io", "test+tag@domain.io"],
    ["First.Last@Example.Org", "first.last@example.org"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeEmail(input), expected);
  }
});

// ── Plus-addressing is preserved ────────────────────────────────────────

test("normalizeEmail: the '+' tag in the local-part is preserved verbatim", () => {
  // Some normalisers strip plus-addressing (a controversial decision).
  // We do NOT — alice+ci@x.com and alice@x.com belong to potentially
  // different filter rules and a strip would silently merge them.
  assert.equal(normalizeEmail("Alice+CI@example.com"), "alice+ci@example.com");
});
