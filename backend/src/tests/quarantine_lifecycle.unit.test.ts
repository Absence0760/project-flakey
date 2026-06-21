/**
 * Phase 15.3 pure-helper unit tests — the deterministic seams the quarantine
 * lifecycle hangs on:
 *
 *   - quarantineExpiryState / isQuarantineExpired: the is-expired / expiring-soon
 *     predicate the nightly sweep filters on AND the frontend renders. A wrong
 *     answer either lifts a still-wanted mute early or lets a quarantine rot past
 *     its declared expiry (the rot gap 15.3 closes). A null expiry must NEVER
 *     read as expired (an indefinite mute is intentional).
 *   - parseExpiresAt: the route-boundary validator (must parse + be future).
 *   - isMd5Hex: the error_fingerprint shape guard.
 *   - shouldSuggestQuarantine: the read-side flaky→quarantine SUGGESTION (never
 *     an action; never suggests an already-muted test).
 *
 * All pure (no DB/I/O), so pinned exhaustively here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  quarantineExpiryState,
  isQuarantineExpired,
  parseExpiresAt,
  isMd5Hex,
  shouldSuggestQuarantine,
} from "../quarantine-lifecycle.js";

const NOW = new Date("2026-06-21T12:00:00Z");
function daysFromNow(n: number): Date {
  return new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);
}

// ── quarantineExpiryState ────────────────────────────────────────────────────

test("a null / empty / unparseable expiry is 'none' (indefinite), never expired", () => {
  for (const v of [null, undefined, "", "garbage"]) {
    const s = quarantineExpiryState(v as Date | string | null | undefined, NOW);
    assert.equal(s.state, "none");
    assert.equal(s.daysRemaining, null);
    assert.equal(isQuarantineExpired(v as Date | string | null | undefined, NOW), false);
  }
});

test("a past expiry is 'expired'", () => {
  const s = quarantineExpiryState(daysFromNow(-1), NOW);
  assert.equal(s.state, "expired");
  assert.equal(isQuarantineExpired(daysFromNow(-1), NOW), true);
});

test("the exact expiry instant counts as expired (boundary)", () => {
  assert.equal(quarantineExpiryState(NOW, NOW).state, "expired");
  assert.equal(isQuarantineExpired(NOW, NOW), true);
});

test("a future expiry is 'active' and daysRemaining is ceiled (a sub-day future reads as 1)", () => {
  const halfDay = new Date(NOW.getTime() + 12 * 60 * 60 * 1000);
  const s = quarantineExpiryState(halfDay, NOW);
  assert.equal(s.state, "active");
  assert.equal(s.daysRemaining, 1);
  assert.equal(isQuarantineExpired(halfDay, NOW), false);
});

test("multi-day future expiry reports the whole-day ceiling", () => {
  assert.equal(quarantineExpiryState(daysFromNow(10), NOW).daysRemaining, 10);
  // 10 days + 1 minute ceils up to 11.
  const justOver = new Date(daysFromNow(10).getTime() + 60 * 1000);
  assert.equal(quarantineExpiryState(justOver, NOW).daysRemaining, 11);
});

test("accepts both Date and ISO-string expiries identically", () => {
  const d = daysFromNow(5);
  assert.deepEqual(quarantineExpiryState(d, NOW), quarantineExpiryState(d.toISOString(), NOW));
});

// ── parseExpiresAt ───────────────────────────────────────────────────────────

test("parseExpiresAt: absence (undefined/null/empty) is the legal 'none' state", () => {
  for (const v of [undefined, null, ""]) {
    assert.deepEqual(parseExpiresAt(v, NOW), { kind: "none" });
  }
});

test("parseExpiresAt: a future ISO string parses to a valid date", () => {
  const future = daysFromNow(3).toISOString();
  const r = parseExpiresAt(future, NOW);
  assert.equal(r.kind, "valid");
  if (r.kind === "valid") assert.equal(r.date.getTime(), Date.parse(future));
});

test("parseExpiresAt: a past or present timestamp is invalid (must be in the future)", () => {
  assert.equal(parseExpiresAt(daysFromNow(-1).toISOString(), NOW).kind, "invalid");
  assert.equal(parseExpiresAt(NOW.toISOString(), NOW).kind, "invalid");
});

test("parseExpiresAt: an unparseable or non-string value is invalid", () => {
  assert.equal(parseExpiresAt("not-a-timestamp", NOW).kind, "invalid");
  assert.equal(parseExpiresAt(12345 as unknown, NOW).kind, "invalid");
  assert.equal(parseExpiresAt({} as unknown, NOW).kind, "invalid");
});

// ── isMd5Hex ─────────────────────────────────────────────────────────────────

test("isMd5Hex accepts a 32-char lowercase hex and rejects everything else", () => {
  assert.equal(isMd5Hex("0123456789abcdef0123456789abcdef"), true);
  assert.equal(isMd5Hex("0123456789ABCDEF0123456789ABCDEF"), false, "uppercase rejected");
  assert.equal(isMd5Hex("0123456789abcdef"), false, "too short");
  assert.equal(isMd5Hex("0123456789abcdef0123456789abcdefa"), false, "too long");
  assert.equal(isMd5Hex("0123456789abcdef0123456789abcdeg"), false, "non-hex char");
  assert.equal(isMd5Hex(null), false);
  assert.equal(isMd5Hex(123), false);
});

// ── shouldSuggestQuarantine ──────────────────────────────────────────────────

test("suggests only when flaky at/above threshold AND not already quarantined", () => {
  assert.equal(shouldSuggestQuarantine({ flakyRate: 60, alreadyQuarantined: false }), true);
  assert.equal(shouldSuggestQuarantine({ flakyRate: 50, alreadyQuarantined: false }), true, "boundary inclusive");
  assert.equal(shouldSuggestQuarantine({ flakyRate: 49, alreadyQuarantined: false }), false);
});

test("never suggests an already-quarantined test", () => {
  assert.equal(shouldSuggestQuarantine({ flakyRate: 99, alreadyQuarantined: true }), false);
});

test("never suggests a non-flaky fingerprint (null/NaN rate)", () => {
  assert.equal(shouldSuggestQuarantine({ flakyRate: null, alreadyQuarantined: false }), false);
  assert.equal(shouldSuggestQuarantine({ flakyRate: NaN, alreadyQuarantined: false }), false);
});

test("respects a custom threshold", () => {
  assert.equal(shouldSuggestQuarantine({ flakyRate: 30, alreadyQuarantined: false, threshold: 25 }), true);
  assert.equal(shouldSuggestQuarantine({ flakyRate: 30, alreadyQuarantined: false, threshold: 40 }), false);
});
