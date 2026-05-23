#!/usr/bin/env bash
# ============================================================================
# fase5_install.sh — Instalacion idempotente de Fase 5 en el VPS:
#   - Copia scripts de backup a /apps/backup/
#   - Instala fail2ban con jail SSH
#   - Cierra UFW port 8080 (Caddy lo proxea internamente)
#   - Configura cron jobs (pg, redis, env, health-check)
#
# Pre-requisito: rclone YA configurado con remote "gdrive" o el que uses.
# Si rclone no esta, ver: https://rclone.org/drive/
#
# Run on VPS:
#   sudo bash /apps/futbol/scripts/vps/fase5_install.sh
# ============================================================================

set -euo pipefail

REPO=/apps/futbol
BACKUP_DIR=/apps/backup
SCRIPTS_DIR=/apps/scripts

if [ "$EUID" -ne 0 ]; then
  echo "❌ Run as root (sudo)"
  exit 1
fi

echo "=================================================="
echo "FASE 5 — Backups + Monitoring + Firewall hardening"
echo "=================================================="

# ── 1. Crear directorios ────────────────────────────────────────────────
mkdir -p $BACKUP_DIR $SCRIPTS_DIR
chmod 700 $BACKUP_DIR $SCRIPTS_DIR

# ── 2. Copiar scripts ───────────────────────────────────────────────────
echo "▶ Copiando scripts de backup..."
cp $REPO/scripts/vps/pg_backup.sh    $BACKUP_DIR/pg_backup.sh
cp $REPO/scripts/vps/redis_backup.sh $BACKUP_DIR/redis_backup.sh
cp $REPO/scripts/vps/env_backup.sh   $BACKUP_DIR/env_backup.sh
cp $REPO/scripts/vps/restore.sh      $BACKUP_DIR/restore.sh
cp $REPO/scripts/vps/health_check.sh $SCRIPTS_DIR/health_check.sh

chmod 700 $BACKUP_DIR/*.sh $SCRIPTS_DIR/*.sh
echo "  ✓ Scripts en $BACKUP_DIR y $SCRIPTS_DIR"

# ── 3. Crear .env si no existe ──────────────────────────────────────────
if [ ! -f $BACKUP_DIR/.env ]; then
  echo "▶ Creando plantilla $BACKUP_DIR/.env..."
  cat > $BACKUP_DIR/.env <<'EOF'
# ── Postgres ──
PGUSER=cfanalisis
PGPASSWORD=Pump0517*
PGDATABASE=cfanalisis
PGHOST=127.0.0.1
PGPORT=5432

# ── Remote (Google Drive via rclone) ──
# Run `rclone config` FIRST para configurar el remote 'gdrive'.
RCLONE_REMOTE=gdrive:cfanalisis-backups

# ── GPG para cifrar env_backup ──
# Run `gpg --gen-key` o usa una clave existente. Pon el email recipient.
GPG_RECIPIENT=ferneyolicas@gmail.com

# ── Telegram alerts ──
# Reusa el bot que usa el worker (mismas vars).
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
EOF
  chmod 600 $BACKUP_DIR/.env
  echo "  ⚠ EDITA $BACKUP_DIR/.env CON TUS VALORES REALES antes de seguir"
  echo "  ⚠ Tras editar, vuelve a ejecutar este script"
  exit 0
else
  echo "  ✓ $BACKUP_DIR/.env ya existe"
fi

# ── 4. Crear health.env si no existe ────────────────────────────────────
if [ ! -f $SCRIPTS_DIR/health.env ]; then
  echo "▶ Creando $SCRIPTS_DIR/health.env..."
  # Reusa TELEGRAM_* del backup .env
  TELEGRAM_BOT_TOKEN=$(grep ^TELEGRAM_BOT_TOKEN= $BACKUP_DIR/.env | cut -d= -f2-)
  TELEGRAM_CHAT_ID=$(grep ^TELEGRAM_CHAT_ID= $BACKUP_DIR/.env | cut -d= -f2-)
  cat > $SCRIPTS_DIR/health.env <<EOF
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID=$TELEGRAM_CHAT_ID
HEALTH_URL=https://worker.cfanalisis.com/health
EOF
  chmod 600 $SCRIPTS_DIR/health.env
fi

# ── 5. Validar rclone ───────────────────────────────────────────────────
if ! command -v rclone >/dev/null; then
  echo "▶ Instalando rclone..."
  curl https://rclone.org/install.sh | bash
fi

RCLONE_REMOTE=$(grep ^RCLONE_REMOTE= $BACKUP_DIR/.env | cut -d= -f2-)
REMOTE_NAME=$(echo "$RCLONE_REMOTE" | cut -d: -f1)

if ! rclone listremotes 2>/dev/null | grep -q "^${REMOTE_NAME}:"; then
  echo "  ⚠ rclone remote '${REMOTE_NAME}:' NO esta configurado"
  echo "  ⚠ Run: rclone config  (configura google drive con nombre '${REMOTE_NAME}')"
  echo "  ⚠ Despues vuelve a ejecutar este script"
  exit 0
fi
echo "  ✓ rclone OK ($RCLONE_REMOTE)"

# ── 6. Instalar fail2ban (SSH brute-force protection) ───────────────────
if ! command -v fail2ban-client >/dev/null; then
  echo "▶ Instalando fail2ban..."
  apt-get update -qq
  apt-get install -y -qq fail2ban
fi

# Config minimal para sshd: 3 fallos en 10 min → ban 1h
cat > /etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled  = true
port     = ssh
filter   = sshd
backend  = systemd
maxretry = 3
findtime = 10m
bantime  = 1h
EOF

systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban
echo "  ✓ fail2ban activo (3 fails / 10m → ban 1h)"

# ── 7. UFW: cerrar puerto 8080 (interno via Caddy worker.cfanalisis.com) ─
if ufw status | grep -qE '^8080[[:space:]]+ALLOW'; then
  echo "▶ Cerrando UFW port 8080..."
  ufw delete allow 8080 2>/dev/null || true
  echo "  ✓ 8080 cerrado externamente (Caddy sigue proxy a localhost:8080)"
else
  echo "  ✓ 8080 ya estaba cerrado"
fi

# ── 8. Crontab: añadir jobs ──────────────────────────────────────────────
# Idempotente: removemos lineas viejas con el mismo path antes de añadir.
CRON_TMP=$(mktemp)
crontab -l 2>/dev/null | grep -v -E '/apps/(backup|scripts)/' > $CRON_TMP || true
cat >> $CRON_TMP <<EOF
# ── cfanalisis Fase 5 backups + monitoring ──
0 3 * * *   $BACKUP_DIR/pg_backup.sh    >> $BACKUP_DIR/backup.log 2>&1
30 3 * * *  $BACKUP_DIR/redis_backup.sh >> $BACKUP_DIR/backup.log 2>&1
0 4 * * 0   $BACKUP_DIR/env_backup.sh   >> $BACKUP_DIR/backup.log 2>&1
*/5 * * * * $SCRIPTS_DIR/health_check.sh >> $SCRIPTS_DIR/health.log 2>&1
EOF
crontab $CRON_TMP
rm -f $CRON_TMP
echo "  ✓ Crontab actualizado"

# ── 9. Smoke-test scripts (no upload, solo verifica que arrancan) ───────
echo "▶ Smoke-test scripts..."
bash -n $BACKUP_DIR/pg_backup.sh    && echo "  ✓ pg_backup.sh syntax OK"
bash -n $BACKUP_DIR/redis_backup.sh && echo "  ✓ redis_backup.sh syntax OK"
bash -n $BACKUP_DIR/env_backup.sh   && echo "  ✓ env_backup.sh syntax OK"
bash -n $SCRIPTS_DIR/health_check.sh && echo "  ✓ health_check.sh syntax OK"

# ── 10. Resumen final ───────────────────────────────────────────────────
echo ""
echo "=================================================="
echo "✅ FASE 5 instalada"
echo "=================================================="
echo ""
echo "Cron jobs activos:"
echo "  03:00 UTC daily  → Postgres backup"
echo "  03:30 UTC daily  → Redis backup"
echo "  04:00 UTC sunday → .env + Caddyfile backup (cifrado GPG)"
echo "  cada 5 min       → Health check"
echo ""
echo "Telegram bot envia:"
echo "  🔴 sobre fallo de backup"
echo "  🔴/🟢 cuando worker.cfanalisis.com cambia estado"
echo ""
echo "Para validar backups manualmente:"
echo "  sudo $BACKUP_DIR/pg_backup.sh"
echo "  sudo $BACKUP_DIR/redis_backup.sh"
echo ""
echo "Para verificar lo que esta en Drive:"
echo "  rclone ls $RCLONE_REMOTE/"
echo ""
echo "fail2ban status:"
echo "  fail2ban-client status sshd"
echo ""
