#!/usr/bin/env bash
# Rota el token Telegram sin incluirlo en argumentos, historial ni salida.
set -euo pipefail
umask 077

if [ "$(id -u)" -ne 0 ]; then
  echo 'Debe ejecutarse como root' >&2
  exit 1
fi
if [ ! -r /dev/tty ]; then
  echo 'Ejecutar desde un terminal interactivo seguro' >&2
  exit 1
fi

printf 'Nuevo token de BotFather (entrada oculta): ' > /dev/tty
IFS= read -r -s NEW_TELEGRAM_TOKEN < /dev/tty
printf '\n' > /dev/tty
if ! [[ "${NEW_TELEGRAM_TOKEN}" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]]; then
  echo 'Formato de token no válido' >&2
  exit 1
fi

rewrite_env() {
  local file="$1"
  local temp
  local found=0
  temp="$(mktemp "${file}.rotate.XXXXXX")"
  while IFS= read -r line || [ -n "${line}" ]; do
    if [[ "${line}" == TELEGRAM_BOT_TOKEN=* ]]; then
      printf 'TELEGRAM_BOT_TOKEN=%s\n' "${NEW_TELEGRAM_TOKEN}" >> "${temp}"
      found=1
    else
      printf '%s\n' "${line}" >> "${temp}"
    fi
  done < "${file}"
  if [ "${found}" -ne 1 ]; then
    rm -f "${temp}"
    echo "Falta TELEGRAM_BOT_TOKEN en ${file}" >&2
    exit 1
  fi
  chown --reference="${file}" "${temp}"
  chmod --reference="${file}" "${temp}"
  mv "${temp}" "${file}"
}

for env_file in \
  /apps/backup/.env \
  /apps/scripts/health.env \
  /apps/futbol/apps/cfanalisis-worker/.env; do
  rewrite_env "${env_file}"
done

printf '%s' "${NEW_TELEGRAM_TOKEN}" > /etc/prometheus/telegram-bot-token
chown root:prometheus /etc/prometheus/telegram-bot-token
chmod 0640 /etc/prometheus/telegram-bot-token
unset NEW_TELEGRAM_TOKEN

pm2 reload cfanalisis-rt --update-env >/dev/null
pm2 reload cfanalisis-heavy --update-env >/dev/null
pm2 save >/dev/null
systemctl restart prometheus-alertmanager
echo 'Token Telegram rotado en todos los consumidores; valores no mostrados.'
