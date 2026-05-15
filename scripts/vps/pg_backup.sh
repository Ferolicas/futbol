#!/usr/bin/env bash
# ============================================================================
# pg_backup.sh — Backup diario de PostgreSQL cfanalisis
#
# Instalar en el VPS en /apps/backup/pg_backup.sh con chmod +x.
# Ejecutar via cron (3:00 AM Madrid = 2:00 UTC en invierno, 1:00 UTC en verano).
#   0 3 * * * /apps/backup/pg_backup.sh >> /apps/backup/backup.log 2>&1
#
# Variables de entorno requeridas (en /apps/backup/.env, source-ed por el script):
#   PGUSER, PGPASSWORD, PGDATABASE, PGHOST, PGPORT
#   RCLONE_REMOTE      (ej. b2:cfanalisis-backups/pg)
#   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
#
# Retencion:
#   Local: 2 dias (el resto se borra).
#   Remoto (B2): 30 dias (rclone delete antiguo).
# ============================================================================

set -uo pipefail

BACKUP_DIR="/apps/backup"
ENV_FILE="${BACKUP_DIR}/.env"
LOG_FILE="${BACKUP_DIR}/backup.log"
LOCAL_RETENTION_DAYS=2
REMOTE_RETENTION_DAYS=30

# ── Cargar configuracion ────────────────────────────────────────────────────
if [ -f "${ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  set -a; source "${ENV_FILE}"; set +a
fi

PGUSER="${PGUSER:-cfanalisis}"
PGDATABASE="${PGDATABASE:-cfanalisis}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"

mkdir -p "${BACKUP_DIR}"

TS="$(date -u +'%Y-%m-%d_%H')"
DUMP_FILE="${BACKUP_DIR}/backup_cfanalisis_${TS}.dump"

# ── Helpers ─────────────────────────────────────────────────────────────────
log() {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*"
}

telegram_alert() {
  local msg="$1"
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    log "telegram: token o chat_id no configurado, skipping"
    return 0
  fi
  curl -fsS --max-time 10 \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "text=🔴 cfanalisis backup FAILED: ${msg}" \
    -d "parse_mode=HTML" >/dev/null 2>&1 || \
    log "telegram: alert send failed"
}

fail() {
  log "FAIL: $*"
  telegram_alert "$*"
  exit 1
}

# ── 1. Dump ─────────────────────────────────────────────────────────────────
log "start backup ${DUMP_FILE}"

if ! command -v pg_dump >/dev/null 2>&1; then
  fail "pg_dump no instalado"
fi

if ! PGPASSWORD="${PGPASSWORD:-}" pg_dump \
      -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" \
      -d "${PGDATABASE}" -Fc -Z 6 -f "${DUMP_FILE}"; then
  rm -f "${DUMP_FILE}"
  fail "pg_dump fallo para ${PGDATABASE}"
fi

DUMP_SIZE="$(du -h "${DUMP_FILE}" | cut -f1)"
log "dump OK (${DUMP_SIZE})"

# ── 2. Subir a Backblaze B2 via rclone ─────────────────────────────────────
if [ -z "${RCLONE_REMOTE:-}" ]; then
  fail "RCLONE_REMOTE no configurado en ${ENV_FILE}"
fi

if ! command -v rclone >/dev/null 2>&1; then
  fail "rclone no instalado"
fi

if ! rclone copy "${DUMP_FILE}" "${RCLONE_REMOTE}/" \
      --transfers=1 --checkers=1 --retries=3 --low-level-retries=5; then
  fail "rclone upload fallo a ${RCLONE_REMOTE}"
fi

log "upload OK to ${RCLONE_REMOTE}"

# ── 3. Limpiar locales > N dias ────────────────────────────────────────────
LOCAL_DELETED="$(find "${BACKUP_DIR}" -maxdepth 1 -name 'backup_cfanalisis_*.dump' \
                  -type f -mtime "+${LOCAL_RETENTION_DAYS}" -print -delete | wc -l)"
log "local cleanup: ${LOCAL_DELETED} archivos > ${LOCAL_RETENTION_DAYS}d eliminados"

# ── 4. Limpiar remotos > N dias en B2 ──────────────────────────────────────
if ! rclone delete "${RCLONE_REMOTE}/" \
      --min-age "${REMOTE_RETENTION_DAYS}d" \
      --include 'backup_cfanalisis_*.dump' 2>&1 | tee -a "${LOG_FILE}"; then
  log "WARN: rclone delete fallo (no-fatal)"
fi

log "DONE backup_cfanalisis_${TS}.dump (${DUMP_SIZE})"
exit 0
