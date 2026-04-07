#!/usr/bin/env bash
set -euo pipefail

# Run all migrations in order against the database.
# Usage: ./backend/migrate.sh
#
# Environment variables (all optional, defaults match docker-compose.yml):
#   DB_HOST     (default: localhost)
#   DB_PORT     (default: 5432)
#   DB_USER     (default: flakey)
#   DB_PASSWORD (default: flakey)
#   DB_NAME     (default: flakey)

HOST="${DB_HOST:-localhost}"
PORT="${DB_PORT:-5432}"
USER="${DB_USER:-flakey}"
DB="${DB_NAME:-flakey}"
export PGPASSWORD="${DB_PASSWORD:-flakey}"

DIR="$(cd "$(dirname "$0")/migrations" && pwd)"

echo "Running migrations against $HOST:$PORT/$DB as $USER"

for f in "$DIR"/*.sql; do
  name="$(basename "$f")"
  echo "  $name"
  psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -f "$f" --quiet --set ON_ERROR_STOP=1 2>&1 | grep -v "already exists\|NOTICE" || true
done

echo "Done."
