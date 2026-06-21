// Phase 15.3 — pure, unit-testable helpers for the quarantine lifecycle.
//
// No DB, no I/O. Two seams live here so the nightly expiry sweep and the
// read-side "muted, expiring in N days" display both hang on deterministic,
// timezone-agnostic logic:
//
//   - quarantineExpiryState: the is-expired / expiring-soon predicate, used by
//     BOTH the nightly retention sweep (to remove expired quarantines) and the
//     frontend (to render "expiring in N days" / "no expiry"). A wrong answer
//     either silently un-mutes a still-flaky test early, or lets a quarantine rot
//     past its declared expiry — exactly the "stops rotting silently" gap 15.3
//     closes. Time math is epoch-millis so it's TZ-agnostic.
//
//   - isQuarantineExpired: the boolean the sweep filters on (a thin wrapper over
//     the state above), kept separate so the SQL-driver path has a single,
//     obviously-correct call.

// A md5 fingerprint is 32 lowercase hex chars — the same shape error_groups
// fingerprints take (md5(error_message || '|' || suite_name)). Validating the
// link at the route boundary keeps a malformed value out of the DB column.
const MD5_HEX_RE = /^[0-9a-f]{32}$/;

/** True iff `s` is a 32-char lowercase-hex md5 digest. */
export function isMd5Hex(s: unknown): s is string {
  return typeof s === "string" && MD5_HEX_RE.test(s);
}

/**
 * Validate + normalise a client-supplied `expires_at`.
 *
 * Returns the parsed Date when `raw` is a parseable timestamp strictly in the
 * future relative to `now`; returns `null` for an explicit absence (undefined /
 * null / "" — "no expiry" is a legal, intentional state); returns the string
 * "invalid" sentinel when the value is present but unparseable or not in the
 * future, so the route can 400 distinctly from the no-expiry case.
 *
 * Pure: the caller passes `now` so the future-check is testable without clocks.
 */
export type ParsedExpiry =
  | { kind: "none" }
  | { kind: "valid"; date: Date }
  | { kind: "invalid"; reason: string };

export function parseExpiresAt(raw: unknown, now: Date): ParsedExpiry {
  if (raw === undefined || raw === null || raw === "") return { kind: "none" };
  if (typeof raw !== "string" && !(raw instanceof Date)) {
    return { kind: "invalid", reason: "expires_at must be an ISO timestamp string" };
  }
  const ms = raw instanceof Date ? raw.getTime() : Date.parse(raw);
  if (!Number.isFinite(ms)) {
    return { kind: "invalid", reason: "expires_at must be a parseable ISO timestamp" };
  }
  if (ms <= now.getTime()) {
    return { kind: "invalid", reason: "expires_at must be in the future" };
  }
  return { kind: "valid", date: new Date(ms) };
}

/**
 * The lifecycle state of a single quarantine relative to `now`.
 *
 *  - "none":    no expiry set — muted indefinitely (the rot risk we surface).
 *  - "expired": expires_at is in the past (the sweep removes these).
 *  - "active":  expires_at is in the future; `daysRemaining` is the ceiling of
 *               the remaining whole days (so an expiry 30 minutes out reads as
 *               "1 day", never "0 days", which would wrongly imply expired).
 */
export interface QuarantineExpiryState {
  state: "none" | "active" | "expired";
  daysRemaining: number | null;
}

export function quarantineExpiryState(
  expiresAt: Date | string | null | undefined,
  now: Date
): QuarantineExpiryState {
  if (expiresAt == null || expiresAt === "") {
    return { state: "none", daysRemaining: null };
  }
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(String(expiresAt));
  if (!Number.isFinite(ms)) {
    // An unparseable expiry is treated as "no expiry" rather than expired — we
    // never remove on bad data (mirrors the autoclose rule: act on positive
    // evidence, not on garbage). It surfaces as indefinitely-muted.
    return { state: "none", daysRemaining: null };
  }
  const deltaMs = ms - now.getTime();
  if (deltaMs <= 0) {
    return { state: "expired", daysRemaining: 0 };
  }
  const daysRemaining = Math.ceil(deltaMs / (24 * 60 * 60 * 1000));
  return { state: "active", daysRemaining };
}

/**
 * Pure predicate the nightly sweep filters on: is this quarantine past its
 * expiry as of `now`? A null/absent/unparseable expires_at is NEVER expired —
 * an indefinitely-muted test is intentional and must not be swept away.
 */
export function isQuarantineExpired(
  expiresAt: Date | string | null | undefined,
  now: Date
): boolean {
  return quarantineExpiryState(expiresAt, now).state === "expired";
}

// The default flaky-rate (0–100) at or above which the triage view SUGGESTS a
// quarantine. Coarse on purpose — this is only a hint a human confirms, never an
// auto-action (auto-muting would let the dashboard hide a real regression, the
// trust invariant 15.3 protects).
export const QUARANTINE_SUGGESTION_FLAKY_RATE = 50;

/**
 * Read-side only: should the triage view surface a "Quarantine?" SUGGESTION for
 * this error group? Pure — the caller feeds the worst flaky rate over the
 * group's member tests and whether the test is already quarantined.
 *
 * We suggest (return true) when:
 *  - the test is NOT already quarantined (don't suggest muting a muted test), AND
 *  - its flaky rate is at or above QUARANTINE_SUGGESTION_FLAKY_RATE (it flips
 *    between pass/fail often enough to be noise worth a human's mute decision).
 *
 * This is a SUGGESTION, not an action: nothing here mutes anything. The human
 * confirms in the UI. A non-flaky fingerprint (flakyRate null) is never
 * suggested — a hard, consistent failure is a regression to fix, not mute.
 */
export function shouldSuggestQuarantine(args: {
  flakyRate: number | null | undefined;
  alreadyQuarantined: boolean;
  threshold?: number;
}): boolean {
  if (args.alreadyQuarantined) return false;
  const rate = args.flakyRate;
  if (rate == null || !Number.isFinite(rate)) return false;
  const threshold = args.threshold ?? QUARANTINE_SUGGESTION_FLAKY_RATE;
  return rate >= threshold;
}
