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

# Daily sets are the only local source; retry never creates another dump.
DAILY_ROOT=/var/backups/holding
LATEST_SET="$(find "$DAILY_ROOT" -mindepth 2 -maxdepth 2 -name COMPLETE.json -printf '%h\n' | sort | tail -1)"
[ -n "$LATEST_SET" ] || { echo 'No completed daily set'; exit 1; }
DAY="$(basename "$LATEST_SET")"
for spec in 'postgres/cfanalisis.dump:backup_cfanalisis_:dump:.pg_offsite_success' 'redis.rdb.gz:redis_:rdb.gz:.redis_offsite_success'; do
  IFS=: read -r relative prefix extension marker <<< "$spec"
  file="$LATEST_SET/$relative"
  [ -s "$file" ] || continue
  remote_name="${prefix}${DAY}_01.${extension}"
  rclone copyto "$file" "${RCLONE_REMOTE}/${remote_name}" \
    --transfers=1 --checkers=1 --retries=2 --low-level-retries=3 \
    --retries-sleep=10s --tpslimit=2 --tpslimit-burst=2
  checksum="$(sha256sum "$file" | cut -d' ' -f1)"
  printf '%s  %s\n' "$checksum" "$remote_name" | rclone rcat "${RCLONE_REMOTE}/${remote_name}.sha256"
  touch "${BACKUP_DIR}/${marker}"
done
# Prune only backup names owned by this task, after both uploads succeeded.
YESTERDAY="$(date -d yesterday +%F)"
while IFS= read -r name; do
  if [[ "$name" =~ ^(backup_cfanalisis_|redis_)([0-9]{4}-[0-9]{2}-[0-9]{2})_[0-9]{2}\.(dump|rdb\.gz)(\.sha256)?$ ]]; then
    date_part="${BASH_REMATCH[2]}"
    if [[ "$date_part" < "$YESTERDAY" ]]; then
      rclone deletefile "${RCLONE_REMOTE}/$name"
    fi
  fi
done < <(rclone lsf "$RCLONE_REMOTE" --files-only)
"${BACKUP_DIR}/backup_status_metrics.sh"
