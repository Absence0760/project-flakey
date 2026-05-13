-- RLS on revoked_refresh_tokens, keyed on user_id.
--
-- The table maps `jti` (UUID-shaped opaque string) to `user_id`. It is
-- read on /auth/refresh ("is this jti revoked?") and written on
-- /auth/refresh (rotation) and /auth/logout. There is no org context at
-- this point — a refresh token isn't associated with an org until the
-- next access token is signed.
--
-- Application-side `pool.query` callsites already include user_id in
-- INSERTs and authenticate the jti before reading. RLS adds a
-- defence-in-depth gate: a future bug or compromised credential cannot
-- read another user's revoked-jti list.
--
-- The auth.ts callsites are updated to use `userScopedQuery(payload.id,
-- ...)` from `backend/src/db.ts`, which wraps the query in a transaction
-- and sets `app.current_user_id` for the duration. The policy below
-- mirrors the org-scoped policies' shape.

ALTER TABLE revoked_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE revoked_refresh_tokens FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS revoked_refresh_tokens_user ON revoked_refresh_tokens;
CREATE POLICY revoked_refresh_tokens_user ON revoked_refresh_tokens
  USING (user_id = current_setting('app.current_user_id', true)::int)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::int);
