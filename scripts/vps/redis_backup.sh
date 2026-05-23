#!/usr/bin/env bash
# ============================================================================
# redis_backup.sh — Backup diario de Redis local (BullMQ + app cache).
#
# Redis tiene RDB snapshots automaticos (configurados en /etc/redis/redis.conf
# con `save 900 1` etc.), pero esos viven en /var/lib/redis/dump.rdb dentro
# del MISMO VPS. Si el VPS muere, perdemos todo. Este script copia el RDB
# fuera del VPS via rclone a Google Drive.
#
# Instalar en el VPS en /apps/backup/redis_backup.sh con chmod +x.
# Cron sugerido (a las 3:30 AM Madrid, despues del pg_backup):
#   30 3 * * * /apps/backup/redis_backup.sh >> /apps/backup/backup.log 2>&1
#
# Variables del .env compartido con pg_backup.sh:
#   RCLONE_REMOTE      (ej. gdrive:cfanalisis-backups)
#   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
#
# Retencion:
#   Local: 2 dias.
#   Remoto: 14 dias (Redis es cache + queues, menos critico que Postgres).
# ============================================================================

set -uo pipefail

BACKUP_DIR="/apps/backup"
ENV_FILE="${BACKUP_DIR}/.env"
LOG_FILE="${BACKUP_DIR}/backup.log"
LOCAL_RETENTION_DAYS=2
REMOTE_RETENTION_DAYS=14

if [ -f "${ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  set -a; source "${ENV_FILE}"; set +a
fi

mkdir -p "${BACKUP_DIR}"

TS="$(date -u +'%Y-%m-%d_%H')"
RDB_FILE="${BACKUP_DIR}/redis_${TS}.rdb"

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*"; }

telegram_alert() {
  local msg="$1"
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    log "telegram no configurado, skipping"
    return 0
  fi
  curl -fsS --max-time 10 \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "text=🔴 cfanalisis redis backup FAILED: ${msg}" \
    -d "parse_mode=HTML" >/dev/null 2>&1 || true
}

fail() {
  log "FAIL: $*"
  telegram_alert "$*"
  exit 1
}

log "start redis backup ${RDB_FILE}"

# ── 1. Dump RDB via redis-cli ────────────────────────────────────────────
# `--rdb` le pide al server que escriba un RDB snapshot fresco al path que
# le indicamos. No bloquea operaciones (Redis hace fork BGSAVE internamente).
if ! redis-cli --rdb "${RDB_FILE}" > /dev/null 2>&1; then
  rm -f "${RDB_FILE}"
  fail "redis-cli --rdb fallo"
fi

# Verifica que el archivo se creo y tiene contenido
if [ ! -s "${RDB_FILE}" ]; then
  rm -f "${RDB_FILE}"
  fail "RDB file vacio o no creado"
fi

# Comprime para ahorrar espacio (gzip -6 — default, buen balance)
gzip -f "${RDB_FILE}"
RDB_FILE="${RDB_FILE}.gz"
RDB_SIZE="$(du -h "${RDB_FILE}" | cut -f1)"
log "redis dump OK (${RDB_SIZE})"

# ── 2. Upload via rclone (mismo remote que pg_backup) ────────────────────
if [ -z "${RCLONE_REMOTE:-}" ]; then
  fail "RCLONE_REMOTE no configurado"
fi

if ! command -v rclone >/dev/null 2>&1; then
  fail "rclone no instalado"
fi

if ! rclone copy "${RDB_FILE}" "${RCLONE_REMOTE}/" \
      --transfers=1 --checkers=1 --retries=3; then
  fail "rclone upload fallo"
fi

log "upload OK to ${RCLONE_REMOTE}"

# ── 3. Limpia locales > N dias ───────────────────────────────────────────
find "${BACKUP_DIR}" -maxdepth 1 -name 'redis_*.rdb.gz' \
  -type f -mtime "+${LOCAL_RETENTION_DAYS}" -delete

# ── 4. Limpia remotos > N dias ───────────────────────────────────────────
rclone delete "${RCLONE_REMOTE}/" \
  --min-age "${REMOTE_RETENTION_DAYS}d" \
  --include 'redis_*.rdb.gz' \
  --drive-use-trash=false 2>&1 | tee -a "${LOG_FILE}" || true

log "DONE redis_${TS}.rdb.gz (${RDB_SIZE})"
exit 0
