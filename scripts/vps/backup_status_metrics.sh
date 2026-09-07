#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR=/apps/backup
TEXTFILE_DIR=/var/lib/prometheus/node-exporter
OUTPUT="${TEXTFILE_DIR}/cfanalisis_backup.prom"
TEMP="${OUTPUT}.tmp"
mkdir -p "${TEXTFILE_DIR}"

mtime_or_zero() {
  local target="$1"
  if [ -e "${target}" ]; then stat -c %Y "${target}"; else echo 0; fi
}

latest_mtime() {
  local pattern="$1"
  local latest
  latest="$(find "${BACKUP_DIR}" -maxdepth 1 -type f -name "${pattern}" -printf '%T@\n' | sort -nr | sed -n '1p' | cut -d. -f1)"
  echo "${latest:-0}"
}

{
  echo '# HELP cfanalisis_backup_last_success_unixtime Last successful backup timestamp.'
  echo '# TYPE cfanalisis_backup_last_success_unixtime gauge'
  echo "cfanalisis_backup_last_success_unixtime{kind=\"postgres_local\"} $(latest_mtime 'backup_cfanalisis_*.dump')"
  echo "cfanalisis_backup_last_success_unixtime{kind=\"redis_local\"} $(latest_mtime 'redis_*.rdb.gz')"
  echo "cfanalisis_backup_last_success_unixtime{kind=\"postgres_offsite\"} $(mtime_or_zero "${BACKUP_DIR}/.pg_offsite_success")"
  echo "cfanalisis_backup_last_success_unixtime{kind=\"redis_offsite\"} $(mtime_or_zero "${BACKUP_DIR}/.redis_offsite_success")"
  echo "cfanalisis_backup_last_success_unixtime{kind=\"restore_drill\"} $(mtime_or_zero "${BACKUP_DIR}/.restore_drill_success")"
} > "${TEMP}"
chmod 0644 "${TEMP}"
mv "${TEMP}" "${OUTPUT}"
