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
for f in /app/migrations/*.sql; do
  echo "  Applying $(basename $f)..."
  psql -v ON_ERROR_STOP=1 -q -f "$f" 2>&1 || echo "  Warning: $(basename $f) had errors (may be idempotent, continuing)"
done
echo "[entrypoint] Migrations complete."

echo "[entrypoint] Starting app..."
exec node dist/index.js
