#!/bin/sh
set -e

# Run migrations using the superuser credentials (needed for role creation, RLS setup)
# Falls back to DB_USER/DB_PASSWORD if migration-specific vars aren't set
export PGHOST="$DB_HOST"
export PGPORT="${DB_PORT:-5432}"
export PGDATABASE="${DB_NAME:-flakey}"
export PGUSER="${DB_MIGRATION_USER:-$DB_USER}"
export PGPASSWORD="${DB_MIGRATION_PASSWORD:-$DB_PASSWORD}"

echo "[entrypoint] Running database migrations..."
# Migrations are idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING guards), so
# re-running them on every boot is safe. ON_ERROR_STOP=1 + `set -e` means a real
# migration error aborts container start before `exec node` — the ALB health
# check never goes green and ECS rolls back instead of routing traffic to a
# half-migrated schema. Do NOT swallow psql failures here; migrate.sh and the
# Helm migration-job deliberately let them propagate, and this path must match.
for f in /app/migrations/*.sql; do
  echo "  Applying $(basename $f)..."
  psql -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "[entrypoint] Migrations complete."

# Align the application role's password with the secret the app authenticates
# with. Migration 005 creates flakey_app with a static dev-default password; in
# a managed deployment DB_PASSWORD is a generated/rotated secret that won't
# match, so without this the app — which connects as DB_USER with DB_PASSWORD —
# can never authenticate (the pool fails on first connect). We're still
# connected as the privileged migration role here, so we can set it.
#
# Skipped when the app connects as the migration role itself (no separate role
# to align) or when DB_PASSWORD is empty. psql's :"role" / :'pw' apply
# identifier / literal quoting so the values can't break out of the statement.
APP_DB_USER="${DB_USER:-flakey_app}"
if [ -n "$DB_PASSWORD" ] && [ "$APP_DB_USER" != "$PGUSER" ]; then
  echo "[entrypoint] Aligning '$APP_DB_USER' role password with DB_PASSWORD..."
  # Statement is read from stdin (not -c) because psql performs :"role" /
  # :'pw' variable interpolation through its lexer, which -c command strings
  # skip. The quoted heredoc delimiter stops the shell touching the body.
  psql -v ON_ERROR_STOP=1 -q -v role="$APP_DB_USER" -v pw="$DB_PASSWORD" <<'ALTER_APP_ROLE'
ALTER ROLE :"role" WITH PASSWORD :'pw';
ALTER_APP_ROLE
fi

echo "[entrypoint] Starting app..."
exec node dist/index.js
