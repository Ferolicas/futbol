# Instalación en el VPS (Arsys Ubuntu 24.04)

Todos los archivos de `scripts/vps/` deben subirse al VPS. Esta guía agrupa los pasos manuales de los bloques 1, 2, 3 y 5.

---

## Bloque 1 — Backups automáticos

```bash
# 1. Crear directorio y copiar scripts
sudo mkdir -p /apps/backup
sudo cp pg_backup.sh restore.sh /apps/backup/
sudo cp backup.env.example /apps/backup/.env
sudo chown -R root:root /apps/backup
sudo chmod +x /apps/backup/{pg_backup,restore}.sh
sudo chmod 600 /apps/backup/.env
sudo $EDITOR /apps/backup/.env   # rellenar credenciales

# 2. Instalar rclone si no está
which rclone || curl https://rclone.org/install.sh | sudo bash
```

### 2a. Preparar la carpeta en Google Drive

Antes de configurar rclone, crea **manualmente** la carpeta destino:

1. Abre https://drive.google.com con la cuenta que usarás para los backups.
   Recomendado: una cuenta dedicada (ej. `backups-cfanalisis@gmail.com`) con
   2FA activado, no la cuenta personal del día a día.
2. Botón "Nueva" → "Nueva carpeta" → nombre: `cfanalisis-backups` (en la
   raíz de Mi Unidad, sin anidar).
3. Click derecho → "Configuración para compartir" → asegúrate de que NO
   está compartida con nadie más.

### 2b. Configurar rclone con OAuth (paso interactivo)

El VPS no tiene navegador, así que el flujo OAuth se hace en **dos
máquinas**: VPS para la config + tu portátil para la autenticación.

**En tu portátil** (necesita rclone instalado):

```bash
# En Windows: descarga rclone.exe de https://rclone.org/downloads/
# En Mac/Linux: brew install rclone   o   curl https://rclone.org/install.sh | sudo bash

# Genera el token OAuth. Abre el navegador automáticamente.
rclone authorize "drive"
```

Te pedirá:
- `Use auto config?` → **y** (abre el navegador local)
- Login a Google con la cuenta de backups
- Aceptar permisos para rclone (acceso a Drive)
- Volverá al terminal con un bloque que empieza por `{"access_token":"..."}`
- **Copia ese bloque JSON completo** (incluyendo las llaves) — lo pegarás en el VPS

**En el VPS** (sesión ssh):

```bash
sudo -E rclone config
```

Responde así:

| Pregunta | Respuesta |
|---|---|
| `e) Edit existing remote / n) New remote / ...` | `n` |
| `name>` | `gdrive` |
| `Storage>` | `drive` (escribe `drive` o el número que aparezca) |
| `client_id>` | déjalo vacío (Enter) † |
| `client_secret>` | vacío |
| `scope>` | `1` (Full access all files) |
| `service_account_file>` | vacío |
| `Edit advanced config?` | `n` |
| `Use auto config?` | **`n`** ← clave: el VPS no tiene navegador |
| `Enter verification code>` | **pega aquí el JSON que generaste en el portátil** |
| `Configure this as a Shared Drive?` | `n` |
| `Yes this is OK / Edit this remote / Delete` | `y` |
| menú principal | `q` (quit) |

† **Nota sobre el client_id**: Si lo dejas vacío, rclone usa su cliente OAuth
compartido — funciona pero está rate-limited globalmente (todos los usuarios de
rclone compiten). Para un único backup diario es **suficiente**. Si llegaras a
ver `rate limit exceeded`, crea el tuyo: https://rclone.org/drive/#making-your-own-client-id

### 2c. Validar la configuración

```bash
# Lista carpetas en tu Drive — debes ver "cfanalisis-backups"
rclone lsd gdrive:

# Lista contenido (vacío al principio)
rclone ls gdrive:cfanalisis-backups
```

Si algo falla, edita el remote con `rclone config` → `e` → `gdrive` y revisa.

### 2d. Primer backup y cron

```bash
# Ejecutar manualmente la primera vez para validar
sudo -E /apps/backup/pg_backup.sh
tail -50 /apps/backup/backup.log

# Verificar que llegó al Drive
rclone ls gdrive:cfanalisis-backups

# Cron diario 3:00 AM Madrid
sudo crontab -e
# Añadir:
# 0 3 * * * /apps/backup/pg_backup.sh >> /apps/backup/backup.log 2>&1
```

**Probar restore (en una base de pruebas, NO en producción):**

```bash
sudo -E /apps/backup/restore.sh latest --dry-run
```

### 2e. Si la cuenta es de Google Workspace (opcional)

Si en vez de una cuenta Gmail normal usas una cuenta de Workspace de tu
organización, considera crear un **service account** en Google Cloud Console
con acceso solo a la carpeta `cfanalisis-backups`. Es más limpio que OAuth de
usuario (no expira, no hay riesgo de revocación si cambias la contraseña).
Pasos: https://rclone.org/drive/#service-account-support

---

## Bloque 2 — PgBouncer

```bash
sudo apt update && sudo apt install -y pgbouncer

# Copiar config
sudo cp scripts/vps/pgbouncer.ini /etc/pgbouncer/pgbouncer.ini
sudo chown postgres:postgres /etc/pgbouncer/pgbouncer.ini
sudo chmod 640 /etc/pgbouncer/pgbouncer.ini

# Generar userlist.txt con el hash md5 actual del usuario cfanalisis
sudo -u postgres psql -d cfanalisis -tAc \
  "SELECT '\"' || rolname || '\" \"' || rolpassword || '\"' \
   FROM pg_authid WHERE rolname = 'cfanalisis';" \
  | sudo tee /etc/pgbouncer/userlist.txt
sudo chown postgres:postgres /etc/pgbouncer/userlist.txt
sudo chmod 640 /etc/pgbouncer/userlist.txt

# Habilitar y arrancar
sudo systemctl enable pgbouncer
sudo systemctl restart pgbouncer
sudo systemctl status pgbouncer

# Verificar
psql -h 127.0.0.1 -p 6432 -U cfanalisis cfanalisis -c 'SELECT 1;'
```

**Cambio coordinado del DATABASE_URL** (sólo después de validar la conexión por 6432):

```bash
# Worker en VPS
sudo -E $EDITOR /apps/futbol/apps/cfanalisis-worker/.env
# Cambiar el puerto de 5432 → 6432 en DATABASE_URL

pm2 restart cfanalisis-worker --update-env
pm2 logs cfanalisis-worker --lines 50
```

**Vercel** (panel o CLI):
- Editar `DATABASE_URL` y cambiar `:5432/` → `:6432/`.
- Redeploy.

---

## Bloque 3 — Caddy HTTPS

```bash
# 1. Instalar Caddy (método oficial)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# 2. Copiar Caddyfile
sudo cp scripts/vps/Caddyfile /etc/caddy/Caddyfile
sudo mkdir -p /var/log/caddy
sudo chown caddy:caddy /var/log/caddy

# 3. Abrir 443 (y 80 para validación ACME)
sudo ufw allow 80
sudo ufw allow 443

# 4. Habilitar y arrancar
sudo systemctl enable caddy
sudo systemctl restart caddy
sudo systemctl status caddy

# 5. Verificar HTTPS (Let's Encrypt tarda ~30s la primera vez)
curl -I https://worker.cfanalisis.com/health
```

**Pre-requisito DNS**: `worker.cfanalisis.com` debe apuntar a la IP del VPS antes de arrancar Caddy. Si el DNS no resuelve, Caddy fallará el challenge HTTP-01.

**Acción manual en panel de Arsys**: confirmar que el puerto 443 está abierto en el firewall del proveedor (no solo en UFW). Si no lo está, abrirlo desde el panel.

**No registres Caddy en PM2** — Caddy se gestiona via systemd con restart automático (`Restart=on-failure` ya viene en su service unit).

---

## Bloque 4 — Pino + Telegram alerts

El worker loguea en JSON estructurado (Pino) a **stdout** (captado por PM2)
y opcionalmente a un archivo en `/var/log/cfanalisis/worker.log`. Cuando
un job BullMQ falla, Fastify devuelve 5xx, o el proceso captura un
`uncaughtException`, además se manda una alerta a tu Telegram personal
con dedup de 1 mensaje/minuto por error.

```bash
# 1. Directorio de logs con permisos para el user que corre PM2
sudo mkdir -p /var/log/cfanalisis
# Ajustar al user que ejecuta `pm2 start`. Si PM2 corre como root:
sudo chown -R root:root /var/log/cfanalisis
# Si PM2 corre como otro user (ej. "deploy"):
# sudo chown -R deploy:deploy /var/log/cfanalisis
sudo chmod 755 /var/log/cfanalisis

# 2. Rotación con logrotate (impide que worker.log crezca sin límite)
sudo tee /etc/logrotate.d/cfanalisis-worker > /dev/null <<'EOF'
/var/log/cfanalisis/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF

# Validar logrotate sin esperar al cron
sudo logrotate -d /etc/logrotate.d/cfanalisis-worker  # dry-run
```

`copytruncate` es importante: Pino mantiene el file descriptor abierto, así
que `rotate` puro perdería los logs hasta el siguiente restart de PM2. Con
`copytruncate`, logrotate copia el archivo y luego lo trunca al tamaño 0
manteniendo el mismo inode — Pino sigue escribiendo en el archivo (ahora
vacío) sin interrupción.

### Variables de entorno del worker

Añadir/actualizar en `/apps/futbol/apps/cfanalisis-worker/.env`:

```bash
LOG_LEVEL=info
LOG_FILE=/var/log/cfanalisis/worker.log
TELEGRAM_BOT_TOKEN=<<token de @cfanalisis_bot>>
TELEGRAM_ALERT_CHAT_ID=<<tu chat ID personal (NO el canal -1003910091350)>>
```

**Cómo obtener tu chat ID personal**: abre Telegram, escribe a
[@userinfobot](https://t.me/userinfobot) o
[@RawDataBot](https://t.me/RawDataBot), te devuelve tu ID (un entero
positivo). El chat ID del canal público es negativo (`-100…`) y se usa para
las alertas de backup/uptime; las alertas de errores del worker deben ir a
tu chat personal para no spamear el canal.

```bash
# Aplicar
pm2 restart cfanalisis-worker --update-env

# Verificar que el archivo se está escribiendo
sudo tail -f /var/log/cfanalisis/worker.log
# Debe verse JSON: {"level":30,"time":...,"svc":"cfanalisis-worker","msg":"HTTP server listening"}
```

### Probar la alerta Telegram

Endpoint dedicado que dispara `notifyError` sin pasar por la cola BullMQ —
así no contaminas la queue con jobs fallidos:

```bash
curl -X POST https://worker.cfanalisis.com/admin/test-alert \
  -H "Authorization: Bearer $WORKER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"note":"primer test"}'
```

Debes recibir un mensaje en Telegram con el endpoint, el error sintético y
el timestamp. Si disparas el mismo `note` varias veces seguidas, solo verás
el primero (dedup de 1/min).

### Limpiar jobs fallidos antiguos (si los hay)

Si ya ejecutaste un test inválido antes de este endpoint, habrá jobs
`futbol-analyze-batch` con payload `{}` en la lista de failed. Para
limpiarlos:

```bash
# Opción 1: desde el panel /ferney (botón "Limpiar fallidos" si existe)
# Opción 2: via bullmq + redis-cli local del VPS
redis-cli <<'EOF'
ZRANGE bull:futbol-analyze-batch:failed 0 -1
EOF
# Anota los jobIds y bórralos:
redis-cli ZREM bull:futbol-analyze-batch:failed <jobId>
redis-cli DEL bull:futbol-analyze-batch:<jobId>
```

Los nuevos jobs con payload inválido ya no se reintentan (usan
`UnrecoverableError`), así que con el deploy actual no se vuelve a
acumular el problema.

---

## Bloque 5 — Health check externo

```bash
sudo mkdir -p /apps/scripts
sudo cp scripts/vps/health_check.sh /apps/scripts/
sudo cp scripts/vps/health.env.example /apps/scripts/health.env
sudo chown root:root /apps/scripts/health_check.sh /apps/scripts/health.env
sudo chmod +x /apps/scripts/health_check.sh
sudo chmod 600 /apps/scripts/health.env
sudo $EDITOR /apps/scripts/health.env  # rellenar token y chat id

# Cron cada 5 minutos
sudo crontab -e
# Añadir:
# */5 * * * * /apps/scripts/health_check.sh >> /apps/scripts/health.log 2>&1
```

**Para BetterUptime / UptimeRobot**:
- URL: `https://worker.cfanalisis.com/health`
- Método: GET
- Expected status: `200`
- Expected body contains: `"status":"ok"` ó `"status":"degraded"` (la app considera degraded como funcional)
- Frecuencia recomendada: 1 minuto
- Webhook de alerta al bot Telegram `@cfanalisis_bot` (chat ID se incluye en `health.env`).
