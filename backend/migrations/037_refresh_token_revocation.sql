-- Refresh-token revocation list.
--
-- /auth/logout previously only cleared cookies; the signed refresh
-- token stayed valid until its 7-day exp, which meant a captured
-- token survived logout indefinitely.  /auth/refresh now embeds a
-- random jti in every refresh JWT and consults this table on every
-- use:
--   * /auth/logout inserts the current refresh token's jti so a
--     subsequent /auth/refresh from that token 401s.
--   * /auth/refresh rotates: it inserts the *consumed* jti so the
--     same refresh token cannot be replayed.  A stolen refresh
--     token therefore self-detects the moment the legitimate user
--     refreshes.
--
-- Rows age out naturally once the token's exp passes (a future
-- cron can DELETE WHERE revoked_at < NOW() - INTERVAL '14 days' to
-- bound table size, but the row count is low — ~one per logout per
-- user per session).

CREATE TABLE IF NOT EXISTS revoked_refresh_tokens (
  jti        TEXT PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revoked_refresh_tokens_user
  ON revoked_refresh_tokens(user_id);
