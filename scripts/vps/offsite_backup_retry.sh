#!/usr/bin/env bash
# Reintenta la copia remota sin volver a generar dumps. Está separado del
# backup diario para recuperarse automáticamente de cuotas/caídas temporales.
set -euo pipefail
umask 077

BACKUP_DIR=/apps/backup
ENV_FILE="${BACKUP_DIR}/.env"
if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

if [ -z "${RCLONE_REMOTE:-}" ]; then
  echo 'RCLONE_REMOTE no configurado' >&2
  exit 1
fi

upload_latest() {
  local pattern="$1"
  local marker="$2"
  local latest
  latest="$(find "${BACKUP_DIR}" -maxdepth 1 -type f -name "${pattern}" -printf '%T@ %p\n' | sort -nr | sed -n '1p' | cut -d' ' -f2-)"
  if [ -z "${latest}" ]; then return 0; fi

  rclone copyto "${latest}" "${RCLONE_REMOTE}/$(basename "${latest}")" \
    --transfers=1 --checkers=1 --retries=5 --low-level-retries=10 \
    --retries-sleep=1m --tpslimit=2 --tpslimit-burst=2
  if [ -f "${latest}.sha256" ]; then
    rclone copyto "${latest}.sha256" "${RCLONE_REMOTE}/$(basename "${latest}.sha256")" \
      --transfers=1 --checkers=1 --retries=5 --retries-sleep=1m \
      --tpslimit=2 --tpslimit-burst=2
  fi
  touch "${BACKUP_DIR}/${marker}"
}

upload_latest 'backup_cfanalisis_*.dump' '.pg_offsite_success'
upload_latest 'redis_*.rdb.gz' '.redis_offsite_success'
"${BACKUP_DIR}/backup_status_metrics.sh"
