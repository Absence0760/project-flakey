-- Per-account brute-force lockout.
--
-- The /auth/* endpoints are rate-limited per IP (authLimiter in
-- index.ts), but a per-IP gate alone doesn't protect a single
-- account against a distributed attack where each IP only sends one
-- or two attempts before rotating to the next.  Lockout state lives
-- here on the user row so it survives process restarts and applies
-- regardless of which front-end / source IP the attempts come from.
--
-- locked_until is the wall-clock time after which the account
-- self-unlocks.  /auth/login increments failed_login_attempts on a
-- wrong password and stamps locked_until once the count crosses the
-- threshold; a successful login resets both back to zero.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
