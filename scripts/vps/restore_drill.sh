#!/usr/bin/env bash
# Restaura el último dump en una base efímera y valida que sea consultable.
# Nunca conecta ni escribe en la base de producción.
set -euo pipefail
umask 077

BACKUP_DIR=/apps/backup
DRILL_DB=cfanalisis_restore_drill
LOG_DIR="${BACKUP_DIR}/drills"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/restore-$(date -u +%Y-%m-%dT%H%M%SZ).log"

if [ "${1:-}" != '--run' ]; then
  echo "Uso: $0 --run"
  echo "Destino aislado: ${DRILL_DB}; producción no se modifica."
  exit 2
fi

DUMP_FILE="$(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'backup_cfanalisis_*.dump' -printf '%T@ %p\n' | sort -nr | sed -n '1p' | cut -d' ' -f2-)"
if [ -z "${DUMP_FILE}" ]; then
  echo 'No existe un dump PostgreSQL local' >&2
  exit 1
fi

cleanup() {
  sudo -u postgres dropdb --if-exists "${DRILL_DB}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

{
  echo "[$(date -u +%FT%TZ)] drill start dump=$(basename "${DUMP_FILE}")"
  /usr/lib/postgresql/17/bin/pg_restore --list "${DUMP_FILE}" >/dev/null
  cleanup
  sudo -u postgres createdb "${DRILL_DB}"
  /usr/lib/postgresql/17/bin/pg_restore \
    --dbname="${DRILL_DB}" --no-owner --no-privileges --jobs=2 "${DUMP_FILE}"
  TABLES="$(sudo -u postgres psql -XAtd "${DRILL_DB}" -c "select count(*) from pg_catalog.pg_tables where schemaname not in ('pg_catalog','information_schema')")"
  if [ "${TABLES}" -lt 10 ]; then
    echo "FAIL: solo se restauraron ${TABLES} tablas" >&2
    exit 1
  fi
  sudo -u postgres psql -XAtd "${DRILL_DB}" -c 'select 1' | grep -qx 1
  echo "[$(date -u +%FT%TZ)] drill OK tables=${TABLES}"
} 2>&1 | tee "${LOG_FILE}"

touch "${BACKUP_DIR}/.restore_drill_success"
"${BACKUP_DIR}/backup_status_metrics.sh" >/dev/null 2>&1 || true
