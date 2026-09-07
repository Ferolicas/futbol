#!/usr/bin/env bash
# Provisiona staging lógico y privado. No clona filas ni secretos de producción.
set -euo pipefail
umask 077

if [ "$(id -u)" -ne 0 ]; then
  echo 'Debe ejecutarse como root' >&2
  exit 1
fi

REPO_DIR="$(git rev-parse --show-toplevel)"
STAGING_ROOT=/apps/futbol-staging
DB_NAME=cfanalisis_staging
DB_ROLE=cfanalisis_staging
PASSWORD_FILE="${STAGING_ROOT}/.database-password"

mkdir -p "${STAGING_ROOT}"
if [ ! -s "${PASSWORD_FILE}" ]; then
  openssl rand -hex 32 > "${PASSWORD_FILE}"
  chmod 0600 "${PASSWORD_FILE}"
fi
DB_PASSWORD="$(cat "${PASSWORD_FILE}")"

sudo -u postgres psql -Xv ON_ERROR_STOP=1 --set=db_password="${DB_PASSWORD}" <<'SQL'
SELECT format('CREATE ROLE cfanalisis_staging LOGIN PASSWORD %L', :'db_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cfanalisis_staging') \gexec
SELECT format('ALTER ROLE cfanalisis_staging PASSWORD %L', :'db_password') \gexec
SQL

if ! sudo -u postgres psql -XAtqc "select 1 from pg_database where datname='${DB_NAME}'" | grep -qx 1; then
  sudo -u postgres createdb --owner="${DB_ROLE}" "${DB_NAME}"
fi

TABLE_COUNT="$(sudo -u postgres psql -XAtd "${DB_NAME}" -c "select count(*) from pg_catalog.pg_tables where schemaname='public'")"
if [ "${TABLE_COUNT}" -eq 0 ]; then
  SCHEMA_DUMP="$(mktemp /tmp/cfanalisis-staging-schema.XXXXXX.dump)"
  trap 'rm -f "${SCHEMA_DUMP}"' EXIT INT TERM
  sudo -u postgres pg_dump --format=custom --schema-only --no-owner --no-privileges \
    --dbname=cfanalisis --file="${SCHEMA_DUMP}"
  sudo -u postgres pg_restore --dbname="${DB_NAME}" --role="${DB_ROLE}" \
    --no-owner --no-privileges "${SCHEMA_DUMP}"
fi

STAGING_ENV="${STAGING_ROOT}/.env"
if [ ! -s "${STAGING_ENV}" ]; then
  AUTH_SECRET="$(openssl rand -hex 32)"
  WORKER_SECRET="$(openssl rand -hex 32)"
  CRON_SECRET="$(openssl rand -hex 32)"
  {
    echo 'NODE_ENV=production'
    echo 'APP_ENV=staging'
    echo 'NEXTAUTH_URL=http://127.0.0.1:3100'
    echo "AUTH_JWT_SECRET=${AUTH_SECRET}"
    echo "NEXTAUTH_SECRET=${AUTH_SECRET}"
    echo "WORKER_SECRET=${WORKER_SECRET}"
    echo "CRON_SECRET=${CRON_SECRET}"
    echo "DATABASE_URL=postgresql://${DB_ROLE}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}"
    echo 'DATABASE_SSL=false'
    echo 'DATABASE_POOL_MAX=3'
    echo 'LOCAL_REDIS_HOST=127.0.0.1'
    echo 'LOCAL_REDIS_PORT=6379'
    echo 'LOCAL_REDIS_DB=15'
    echo 'WORKER_URL='
    echo 'RESEND_API_KEY='
    echo 'STRIPE_SECRET_KEY='
    echo 'MERCADOPAGO_ACCESS_TOKEN='
    echo 'FOOTBALL_API_KEY='
    echo 'API_SPORTS_KEY='
  } > "${STAGING_ENV}"
  chmod 0600 "${STAGING_ENV}"
fi

cd "${REPO_DIR}"
bash scripts/vps/deploy-staging.sh
TABLE_COUNT="$(sudo -u postgres psql -XAtd "${DB_NAME}" -c "select count(*) from pg_catalog.pg_tables where schemaname='public'")"
echo "Staging listo en 127.0.0.1:3100 con ${TABLE_COUNT} tablas y sin datos LIVE."
