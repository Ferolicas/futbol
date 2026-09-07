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
#   RCLONE_REMOTE      (ej. gdrive:cfanalisis-backups)
#   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
#
# Retencion:
#   Local: 7 dias por defecto.
#   Remoto (Google Drive): 30 dias por defecto. La eliminacion usa la
#   papelera del proveedor para que un error operativo siga siendo recuperable.
# ============================================================================

set -uo pipefail
umask 077

BACKUP_DIR="/apps/backup"
ENV_FILE="${BACKUP_DIR}/.env"
LOG_FILE="${BACKUP_DIR}/backup.log"
LOCAL_RETENTION_DAYS="${LOCAL_RETENTION_DAYS:-7}"
REMOTE_RETENTION_DAYS="${REMOTE_RETENTION_DAYS:-30}"

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

if ! PGPASSWORD="${PGPASSWORD:-}" /usr/lib/postgresql/17/bin/pg_dump \
      -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" \
      -d "${PGDATABASE}" -Fc -Z 6 -f "${DUMP_FILE}"; then
  rm -f "${DUMP_FILE}"
  fail "pg_dump fallo para ${PGDATABASE}"
fi

if ! /usr/lib/postgresql/17/bin/pg_restore --list "${DUMP_FILE}" >/dev/null; then
  rm -f "${DUMP_FILE}"
  fail "pg_restore --list no pudo validar el dump"
fi

sha256sum "${DUMP_FILE}" > "${DUMP_FILE}.sha256"

DUMP_SIZE="$(du -h "${DUMP_FILE}" | cut -f1)"
log "dump OK (${DUMP_SIZE})"

# ── 2. Subir a Google Drive via rclone ─────────────────────────────────────
if [ -z "${RCLONE_REMOTE:-}" ]; then
  fail "RCLONE_REMOTE no configurado en ${ENV_FILE}"
fi

if ! command -v rclone >/dev/null 2>&1; then
  fail "rclone no instalado"
fi

# --drive-chunk-size 64M acelera uploads para .dump >100MB sin pasarse de RAM.
# Si la base crece a varios GB, considerar 128M.
if ! rclone copyto "${DUMP_FILE}" "${RCLONE_REMOTE}/$(basename "${DUMP_FILE}")" \
      --transfers=1 --checkers=1 --retries=8 --low-level-retries=10 \
      --retries-sleep=1m --tpslimit=2 --tpslimit-burst=2 \
      --drive-chunk-size=64M; then
  fail "rclone upload fallo a ${RCLONE_REMOTE}"
fi

if ! rclone copyto "${DUMP_FILE}.sha256" "${RCLONE_REMOTE}/$(basename "${DUMP_FILE}.sha256")" \
      --transfers=1 --checkers=1 --retries=5 --retries-sleep=1m \
      --tpslimit=2 --tpslimit-burst=2; then
  fail "rclone upload del checksum fallo a ${RCLONE_REMOTE}"
fi

touch "${BACKUP_DIR}/.pg_offsite_success"

log "upload OK to ${RCLONE_REMOTE}"

# ── 3. Limpiar locales > N dias ────────────────────────────────────────────
LOCAL_DELETED="$(find "${BACKUP_DIR}" -maxdepth 1 -name 'backup_cfanalisis_*.dump' \
                  -type f -mtime "+${LOCAL_RETENTION_DAYS}" -print -delete | wc -l)"
find "${BACKUP_DIR}" -maxdepth 1 -name 'backup_cfanalisis_*.dump.sha256' \
  -type f -mtime "+${LOCAL_RETENTION_DAYS}" -delete
log "local cleanup: ${LOCAL_DELETED} archivos > ${LOCAL_RETENTION_DAYS}d eliminados"

# ── 4. Limpiar remotos > N dias en Google Drive ────────────────────────────
# La configuracion predeterminada de Google Drive envia los expirados a la
# papelera: es intencionado para conservar una ventana de recuperacion.
if ! rclone delete "${RCLONE_REMOTE}/" \
      --min-age "${REMOTE_RETENTION_DAYS}d" \
      --include 'backup_cfanalisis_*.dump*' \
      --tpslimit=2 --tpslimit-burst=2 2>&1 | tee -a "${LOG_FILE}"; then
  log "WARN: rclone delete fallo (no-fatal)"
fi

log "DONE backup_cfanalisis_${TS}.dump (${DUMP_SIZE})"
"${BACKUP_DIR}/backup_status_metrics.sh" >/dev/null 2>&1 || true
exit 0
