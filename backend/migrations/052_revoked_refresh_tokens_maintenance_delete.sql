-- Allow a system maintenance path to prune aged-out revoked-refresh-token rows.
--
-- revoked_refresh_tokens is FORCE-RLS and user-scoped (migration 040). That
-- correctly blocks cross-user reads/writes, but it also means the background
-- retention job — which runs as flakey_app with NO user context — cannot
-- delete expired rows. The table therefore grows without bound (the TODO noted
-- in migration 037's comment).
--
-- Add a permissive DELETE-only policy gated on a session GUC that only the
-- retention job sets: app.maintenance = 'on', applied LOCAL inside a
-- transaction via maintenanceQuery() in backend/src/db.ts. Postgres combines
-- permissive policies with OR, so:
--   * a normal request (app.maintenance unset → NULL) is still governed solely
--     by the per-user policy — it can only ever touch its own rows;
--   * no request handler sets app.maintenance, so this cannot widen
--     user-facing access; only the server-side maintenance helper flips it.
--
-- The maintenance policy is FOR ALL (not FOR DELETE): a DELETE's WHERE clause
-- still needs the row to be SELECT-visible, and the per-user SELECT policy
-- hides every row when no user GUC is set. USING (maintenance='on') therefore
-- covers both the SELECT visibility and the DELETE; WITH CHECK (false) blocks
-- INSERT/UPDATE so the maintenance context can only ever read and prune, never
-- forge or mutate revocation rows.
--
-- Empty-string hardening: the maintenance path does NOT set
-- app.current_user_id, but Postgres still evaluates the per-user policy's
-- USING expression for the same row (permissive policies are OR'd). On a
-- pooled connection a previously set-LOCAL GUC reverts to '' (not unset) after
-- COMMIT, so the bare `current_setting(...)::int` cast in migration 040 throws
-- "invalid input syntax for type integer" the moment a query runs without
-- first setting the GUC. Re-create the per-user policy with NULLIF so '' maps
-- to NULL (comparison → false) instead of erroring. Behaviour is identical
-- when the GUC holds a real id.

DROP POLICY IF EXISTS revoked_refresh_tokens_user ON revoked_refresh_tokens;
CREATE POLICY revoked_refresh_tokens_user ON revoked_refresh_tokens
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::int)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::int);

DROP POLICY IF EXISTS revoked_refresh_tokens_maintenance_delete ON revoked_refresh_tokens;
DROP POLICY IF EXISTS revoked_refresh_tokens_maintenance ON revoked_refresh_tokens;
CREATE POLICY revoked_refresh_tokens_maintenance ON revoked_refresh_tokens
  FOR ALL
  USING (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (false);
