#!/usr/bin/env bash
# Bring the two servers the ingest end-to-end tests talk to up or down.
#
#   scripts/e2e-databases.sh up      # start, wait, load fixtures
#   scripts/e2e-databases.sh down    # stop and remove
#
# Ports are deliberately off the defaults (55432 / 33306) so a developer's own
# PostgreSQL or MySQL keeps its port.
set -euo pipefail

PG_CONTAINER=dsh-pg-test
MYSQL_CONTAINER=dsh-mysql-test
PG_PORT=55432
MYSQL_PORT=33306
PASSWORD=testpass
FIXTURES="$(cd "$(dirname "${BASH_SOURCE[0]}")/../tests/ingest/fixtures" && pwd)"

wait_for() {
  local label=$1 description=$2
  shift 2
  for _ in $(seq 1 60); do
    if "$@" >/dev/null 2>&1; then
      echo "${label} ready"
      return 0
    fi
    sleep 2
  done
  echo "${label} did not come up" >&2
  return 1
}

up() {
  docker rm -f "$PG_CONTAINER" "$MYSQL_CONTAINER" >/dev/null 2>&1 || true

  docker run -d --name "$PG_CONTAINER" \
    -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=business \
    -p "${PG_PORT}:5432" postgres:16-alpine >/dev/null

  docker run -d --name "$MYSQL_CONTAINER" \
    -e MYSQL_ROOT_PASSWORD="$PASSWORD" -e MYSQL_DATABASE=business \
    -p "${MYSQL_PORT}:3306" mysql:8 >/dev/null

  wait_for PostgreSQL postgres \
    docker exec "$PG_CONTAINER" pg_isready -U postgres
  wait_for MySQL mysql \
    docker exec "$MYSQL_CONTAINER" mysqladmin ping -uroot -p"$PASSWORD" --silent

  docker exec -i "$PG_CONTAINER" psql -U postgres -d business < "${FIXTURES}/schema.sql" >/dev/null
  # --default-character-set: the client falls back to latin1 without a tty.
  docker exec -i "$MYSQL_CONTAINER" mysql -uroot -p"$PASSWORD" business \
    --default-character-set=utf8mb4 < "${FIXTURES}/schema-mysql.sql" 2>/dev/null

  echo "fixtures loaded; run \`pnpm test\`"
}

down() {
  docker rm -f "$PG_CONTAINER" "$MYSQL_CONTAINER" >/dev/null 2>&1 || true
  echo "removed"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 {up|down}" >&2; exit 2 ;;
esac
