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
  # Run psql separately from the noise filter so the grep `|| true`
  # can't mask a real failure. Capture psql output + status, then
  # filter noise on the captured string. Previous form
  # (`psql … 2>&1 | grep -v … || true`) let a half-applied migration
  # silently print "Done." because the trailing `|| true`
  # neutralised pipefail's last-non-zero rule.
  set +e
  out="$(psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -f "$f" --quiet --set ON_ERROR_STOP=1 2>&1)"
  status=$?
  set -e
  echo "$out" | grep -v "already exists\|NOTICE" || true
  if [ "$status" -ne 0 ]; then
    echo "MIGRATION FAILED: $name (psql exit $status)" >&2
    exit 1
  fi
done

echo "Done."
