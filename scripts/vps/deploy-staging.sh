#!/usr/bin/env bash
# Publica un staging privado desde el runtime ya validado de producción.
# Reutiliza archivos inmutables con hardlinks, pero reemplaza por completo el
# .env: staging nunca hereda credenciales LIVE.
set -euo pipefail
umask 077

REPO_DIR="$(git rev-parse --show-toplevel)"
STAGING_ROOT=/apps/futbol-staging
STAGING_ENV="${STAGING_ROOT}/.env"
CURRENT_FILE="${REPO_DIR}/.web-releases/current"

if [ ! -s "${STAGING_ENV}" ]; then
  echo "staging skip: falta ${STAGING_ENV}"
  exit 0
fi
if [ ! -s "${CURRENT_FILE}" ]; then
  echo 'staging error: falta release activa' >&2
  exit 1
fi

SOURCE_RELEASE="$(cat "${CURRENT_FILE}")"
SOURCE_RUNTIME="${SOURCE_RELEASE}/.next/standalone"
if [ ! -f "${SOURCE_RUNTIME}/server.js" ]; then
  echo 'staging error: runtime de producción inválido' >&2
  exit 1
fi

mkdir -p "${STAGING_ROOT}/releases"
TARGET="$(mktemp -d "${STAGING_ROOT}/releases/release-$(git rev-parse --short HEAD)-XXXXXX")"
cp -al "${SOURCE_RUNTIME}/." "${TARGET}/"
rm -f "${TARGET}/.env"
install -m 600 "${STAGING_ENV}" "${TARGET}/.env"

node - "${TARGET}" <<'JS'
const fs = require('node:fs');
const dir = process.argv[2];
const config = {
  apps: [{
    name: 'cfanalisis-staging',
    script: `${dir}/server.js`,
    cwd: dir,
    interpreter: 'node',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    max_memory_restart: '768M',
    env: {
      NODE_ENV: 'production',
      APP_ENV: 'staging',
      PORT: 3100,
      HOSTNAME: '127.0.0.1',
    },
  }],
};
fs.writeFileSync(`${dir}/staging.config.json`, JSON.stringify(config), { mode: 0o600 });
JS

if pm2 describe cfanalisis-staging >/dev/null 2>&1; then
  pm2 delete cfanalisis-staging >/dev/null
fi
pm2 start "${TARGET}/staging.config.json" --only cfanalisis-staging --update-env

for attempt in 1 2 3 4 5; do
  if curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3100/api/health >/dev/null; then
    printf '%s\n' "${TARGET}" > "${STAGING_ROOT}/current"
    pm2 save >/dev/null
    echo "STAGING_RELEASE_ACTIVE: $(basename "${TARGET}")"
    exit 0
  fi
  sleep 1
done

echo 'staging candidate failed health check' >&2
exit 1
