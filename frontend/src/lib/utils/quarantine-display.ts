// Pure helpers for rendering a quarantine's lifecycle state (Phase 15.3). Kept
// free of Svelte and the API client so the "muted, expiring in N days" / "muted
// with no expiry" / "expired" display logic is unit-testable in isolation.
//
// Mirrors the backend's quarantineExpiryState (src/quarantine-lifecycle.ts): the
// two must agree on what "expired" / "expiring soon" means, since the backend
// sweep removes expired rows and this drives the badge a human reads. Epoch-ms
// math so it's timezone-agnostic.

export type QuarantineExpiryState = "none" | "active" | "expired";

export interface QuarantineDisplay {
  state: QuarantineExpiryState;
  daysRemaining: number | null;
  // A short, human-facing label for the badge.
  label: string;
  // True when an active quarantine is close enough to expiry to nudge the user
  // (≤ `soonDays`), so the UI can tint it as "expiring soon".
  expiringSoon: boolean;
}

/**
 * Derive the display state for a quarantine from its `expires_at`.
 *
 *  - null / "" / unparseable  → "muted with no expiry" (the rot risk we surface).
 *  - expires_at in the past   → "muted — expired" (the sweep will remove it).
 *  - expires_at in the future → "muted, expiring in N days" (N = whole days,
 *    ceiling so an expiry 30 minutes out reads as "1 day", never "0 days").
 *
 * `soonDays` (default 3) is the window inside which `expiringSoon` is true.
 */
export function quarantineDisplay(
  expiresAt: string | null | undefined,
  now: Date = new Date(),
  soonDays = 3
): QuarantineDisplay {
  if (expiresAt == null || expiresAt === "") {
    return { state: "none", daysRemaining: null, label: "Muted, no expiry", expiringSoon: false };
  }
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) {
    // An unparseable expiry reads as indefinite, never as expired — we never
    // imply removal on bad data (matches the backend predicate).
    return { state: "none", daysRemaining: null, label: "Muted, no expiry", expiringSoon: false };
  }

  const deltaMs = ms - now.getTime();
  if (deltaMs <= 0) {
    return { state: "expired", daysRemaining: 0, label: "Muted — expired", expiringSoon: false };
  }

  const daysRemaining = Math.ceil(deltaMs / (24 * 60 * 60 * 1000));
  const label =
    daysRemaining === 1 ? "Muted, expiring in 1 day" : `Muted, expiring in ${daysRemaining} days`;
  return { state: "active", daysRemaining, label, expiringSoon: daysRemaining <= soonDays };
}
