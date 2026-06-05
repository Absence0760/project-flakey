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

echo "[entrypoint] Starting app..."
exec node dist/index.js
