#!/usr/bin/env bash
# Rota AUTH_JWT_SECRET sin imprimir valores y conserva la clave anterior para
# verificar las cookies emitidas durante los 30 días previos.
set -euo pipefail
umask 077

if [ "$(id -u)" -ne 0 ]; then
  echo 'Debe ejecutarse como root' >&2
  exit 1
fi

ENV_FILE="${CFANALISIS_ENV_FILE:-/apps/futbol/.env}"
if [ ! -r "${ENV_FILE}" ]; then
  echo "No se puede leer ${ENV_FILE}" >&2
  exit 1
fi

OLD_AUTH_SECRET=''
while IFS= read -r line || [ -n "${line}" ]; do
  if [[ "${line}" == AUTH_JWT_SECRET=* ]]; then
    OLD_AUTH_SECRET="${line#AUTH_JWT_SECRET=}"
  fi
done < "${ENV_FILE}"

if [[ "${OLD_AUTH_SECRET}" == \"*\" && "${OLD_AUTH_SECRET}" == *\" ]]; then
  OLD_AUTH_SECRET="${OLD_AUTH_SECRET:1:${#OLD_AUTH_SECRET}-2}"
elif [[ "${OLD_AUTH_SECRET}" == \'*\' && "${OLD_AUTH_SECRET}" == *\' ]]; then
  OLD_AUTH_SECRET="${OLD_AUTH_SECRET:1:${#OLD_AUTH_SECRET}-2}"
fi
if [ "${#OLD_AUTH_SECRET}" -lt 32 ]; then
  echo 'AUTH_JWT_SECRET actual ausente o demasiado corto' >&2
  exit 1
fi

NEW_AUTH_SECRET="$(openssl rand -hex 48)"
TEMP_FILE="$(mktemp "${ENV_FILE}.rotate.XXXXXX")"
FOUND_CURRENT=0
FOUND_PREVIOUS=0
FOUND_NEXTAUTH=0

while IFS= read -r line || [ -n "${line}" ]; do
  case "${line}" in
    AUTH_JWT_SECRET=*)
      printf 'AUTH_JWT_SECRET=%s\n' "${NEW_AUTH_SECRET}" >> "${TEMP_FILE}"
      FOUND_CURRENT=1
      ;;
    AUTH_JWT_SECRET_PREVIOUS=*)
      printf 'AUTH_JWT_SECRET_PREVIOUS=%s\n' "${OLD_AUTH_SECRET}" >> "${TEMP_FILE}"
      FOUND_PREVIOUS=1
      ;;
    NEXTAUTH_SECRET=*)
      printf 'NEXTAUTH_SECRET=%s\n' "${NEW_AUTH_SECRET}" >> "${TEMP_FILE}"
      FOUND_NEXTAUTH=1
      ;;
    *) printf '%s\n' "${line}" >> "${TEMP_FILE}" ;;
  esac
done < "${ENV_FILE}"

if [ "${FOUND_CURRENT}" -ne 1 ]; then
  rm -f "${TEMP_FILE}"
  echo 'Falta AUTH_JWT_SECRET en el archivo de entorno' >&2
  exit 1
fi
if [ "${FOUND_PREVIOUS}" -eq 0 ]; then
  printf 'AUTH_JWT_SECRET_PREVIOUS=%s\n' "${OLD_AUTH_SECRET}" >> "${TEMP_FILE}"
fi
if [ "${FOUND_NEXTAUTH}" -eq 0 ]; then
  printf 'NEXTAUTH_SECRET=%s\n' "${NEW_AUTH_SECRET}" >> "${TEMP_FILE}"
fi

chown --reference="${ENV_FILE}" "${TEMP_FILE}"
chmod --reference="${ENV_FILE}" "${TEMP_FILE}"
mv "${TEMP_FILE}" "${ENV_FILE}"
unset OLD_AUTH_SECRET NEW_AUTH_SECRET

cd /apps/futbol
bash scripts/vps/deploy-web.sh
pm2 save >/dev/null
printf '%s AUTH_JWT_SECRET rotated; previous key retained for 30-day cookie transition\n' "$(date -Is)" >> /var/log/cfanalisis-secret-rotation.log
echo 'AUTH_JWT_SECRET rotado; las sesiones existentes siguen aceptadas durante la transición.'
