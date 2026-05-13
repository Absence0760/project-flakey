-- Hardened API-key verification path.
--
-- The previous `lookup_api_key(prefix)` SECURITY DEFINER function
-- returned `key_hash` (the bcrypt hash) to JS so the application could
-- run `bcrypt.compareSync(plaintext, key_hash)`. Any caller able to
-- execute this function (any user/role with EXECUTE on the schema's
-- functions, including flakey_app) could enumerate prefixes and dump
-- every API-key bcrypt hash — and use them for offline cracking.
--
-- This migration:
--   1. Loads pgcrypto so we can run bcrypt comparisons in the DB.
--   2. Adds a new `verify_api_key(p_prefix, p_full_key)` SECURITY
--      DEFINER function that performs the bcrypt comparison server-side
--      and returns ONLY the matched row's identity columns — never the
--      hash itself.
--   3. Revokes EXECUTE on the old `lookup_api_key()` from PUBLIC and
--      flakey_app so the leak path is closed. The function definition
--      stays so any old session that was still calling it during a
--      rolling deploy fails closed (permission denied) instead of
--      silently returning hashes after the application code is updated.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- pgcrypto's crypt() only accepts the `$2a$` bcrypt prefix; bcryptjs
-- (the JS lib that wrote these hashes) uses `$2b$`. The two formats
-- are functionally identical — `$2b$` was introduced in 2014 to fix
-- a C-side bug that didn't affect the algorithm. The regex below
-- normalises `$2b$`/`$2y$` to `$2a$` for the comparison so existing
-- hashes verify correctly.
--
-- Standard-conforming-string note: `'^\$2[by]\$'` is literally the
-- regex `^\$2[by]\$` (backslash-dollar matches a literal `$`). The
-- replacement string `'$2a$'` is literal `$2a$` — `$` is NOT a
-- backreference in regexp_replace; `\1`/`\2` etc are. We do NOT
-- escape the dollars in the replacement.
CREATE OR REPLACE FUNCTION verify_api_key(p_prefix TEXT, p_full_key TEXT)
RETURNS TABLE(key_id INT, user_id INT, email TEXT, name TEXT, user_role TEXT, org_id INT)
LANGUAGE sql SECURITY DEFINER
AS $$
  SELECT ak.id, u.id, u.email, u.name, u.role, ak.org_id
  FROM api_keys ak
  JOIN users u ON u.id = ak.user_id
  WHERE ak.key_prefix = p_prefix
    AND crypt(p_full_key, regexp_replace(ak.key_hash, '^\$2[by]\$', '$2a$'))
        = regexp_replace(ak.key_hash, '^\$2[by]\$', '$2a$');
$$;

-- Lock down the old function so it can't continue to leak hashes
-- once the application is on the new path. Keep the definition so
-- that an in-flight pre-deploy session calling it gets a clean
-- permission-denied (fail closed) instead of a silent surprise.
REVOKE ALL ON FUNCTION lookup_api_key(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION lookup_api_key(TEXT) FROM flakey_app;

-- Grant the new function to the app role.
GRANT EXECUTE ON FUNCTION verify_api_key(TEXT, TEXT) TO flakey_app;
