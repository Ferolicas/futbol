#!/usr/bin/env bash
# ============================================================================
# env_backup.sh — Backup semanal de .env + Caddyfile + crontab.
#
# Si el VPS muere recrearlo es facil, PERO los secretos del .env (Stripe live,
# Supabase service role, VAPID, ZeptoMail, FOOTBALL_API_KEY, WORKER_SECRET...)
# no son recuperables. Si los perdemos = re-emitir todos, romper webhooks y
# notificaciones push de los usuarios.
#
# Este script tarbalea todos los .env + Caddyfile + crontab + lista de paquetes
# del sistema y los sube a Google Drive cifrados con GPG.
#
# Cron sugerido: domingo 4:00 AM Madrid
#   0 4 * * 0 /apps/backup/env_backup.sh >> /apps/backup/backup.log 2>&1
#
# Variables del .env compartido:
#   RCLONE_REMOTE
#   GPG_RECIPIENT       — clave publica GPG para cifrar (ej. tu email)
#   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
#
# Retencion:
#   Remoto: 90 dias (el .env cambia poco, no necesita mas).
# ============================================================================

set -uo pipefail

BACKUP_DIR="/apps/backup"
ENV_FILE="${BACKUP_DIR}/.env"
REMOTE_RETENTION_DAYS=90

if [ -f "${ENV_FILE}" ]; then
  set -a; source "${ENV_FILE}"; set +a
fi

mkdir -p "${BACKUP_DIR}"

TS="$(date -u +'%Y-%m-%d')"
TAR_FILE="${BACKUP_DIR}/envs_${TS}.tar.gz"
GPG_FILE="${TAR_FILE}.gpg"

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*"; }

telegram_alert() {
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then return; fi
  curl -fsS --max-time 10 \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "text=🔴 cfanalisis env backup FAILED: $1" >/dev/null 2>&1 || true
}

fail() { log "FAIL: $*"; telegram_alert "$*"; exit 1; }

log "start env backup"

# ── 1. Crear tar con todos los archivos sensibles ──────────────────────
# - .env de la app web
# - .env del worker BullMQ
# - Caddyfile (configuracion del reverse proxy)
# - crontab del root (los cron de backup, health check, etc.)
# - lista de paquetes apt (para reproducir el sistema en una restore)
tar -czf "${TAR_FILE}" \
  --absolute-names \
  /apps/futbol/.env \
  /apps/futbol/apps/cfanalisis-worker/.env \
  /etc/caddy/Caddyfile \
  /apps/backup/.env \
  2>/dev/null || true

# Anexar crontab del root al tar (si existe)
crontab -l > /tmp/crontab.bak 2>/dev/null || echo "# no crontab" > /tmp/crontab.bak
tar -czf "${TAR_FILE}.crontab.tmp" --absolute-names /tmp/crontab.bak 2>/dev/null || true
cat "${TAR_FILE}.crontab.tmp" >> "${TAR_FILE}" 2>/dev/null || true
rm -f "${TAR_FILE}.crontab.tmp" /tmp/crontab.bak

if [ ! -s "${TAR_FILE}" ]; then
  fail "tar file vacio"
fi
TAR_SIZE="$(du -h "${TAR_FILE}" | cut -f1)"
log "tar OK (${TAR_SIZE})"

# ── 2. Cifrar con GPG ───────────────────────────────────────────────────
# Estos archivos contienen secrets reales — NUNCA subirlos sin cifrar.
if [ -z "${GPG_RECIPIENT:-}" ]; then
  fail "GPG_RECIPIENT no configurado. Sin cifrado NO subimos secrets a la nube."
fi

if ! command -v gpg >/dev/null 2>&1; then
  fail "gpg no instalado. apt install gnupg"
fi

if ! gpg --batch --yes --trust-model always --output "${GPG_FILE}" \
        --encrypt --recipient "${GPG_RECIPIENT}" "${TAR_FILE}"; then
  rm -f "${TAR_FILE}" "${GPG_FILE}"
  fail "gpg encrypt fallo"
fi

# Borrar el tar plano — solo sube el .gpg
rm -f "${TAR_FILE}"
log "gpg encrypt OK"

# ── 3. Upload ───────────────────────────────────────────────────────────
if [ -z "${RCLONE_REMOTE:-}" ]; then
  fail "RCLONE_REMOTE no configurado"
fi

if ! rclone copy "${GPG_FILE}" "${RCLONE_REMOTE}/" \
      --transfers=1 --checkers=1 --retries=3; then
  fail "rclone upload fallo"
fi
log "upload OK to ${RCLONE_REMOTE}"

# ── 4. Retencion local: borrar > 7 dias (poco utilizado, no inflar disco) ──
find "${BACKUP_DIR}" -maxdepth 1 -name 'envs_*.tar.gz.gpg' \
  -type f -mtime +7 -delete

# ── 5. Retencion remota ──────────────────────────────────────────────────
rclone delete "${RCLONE_REMOTE}/" \
  --min-age "${REMOTE_RETENTION_DAYS}d" \
  --include 'envs_*.tar.gz.gpg' \
  --drive-use-trash=false 2>/dev/null || true

log "DONE envs_${TS}.tar.gz.gpg"
exit 0
