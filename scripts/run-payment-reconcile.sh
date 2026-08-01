#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/apps/futbol"
ENV_FILE="$APP_DIR/.env"

if [ ! -r "$ENV_FILE" ]; then
  logger -t cfanalisis-payments "missing $ENV_FILE"
  exit 1
fi

PAYMENT_CRON_SECRET=$(sed -n 's/^CRON_SECRET=//p' "$ENV_FILE" | head -n 1)
PAYMENT_CRON_SECRET=${PAYMENT_CRON_SECRET#\"}
PAYMENT_CRON_SECRET=${PAYMENT_CRON_SECRET%\"}
PAYMENT_CRON_SECRET=${PAYMENT_CRON_SECRET#\'}
PAYMENT_CRON_SECRET=${PAYMENT_CRON_SECRET%\'}

if [[ ! "$PAYMENT_CRON_SECRET" =~ ^[A-Za-z0-9._~+/=-]{32,}$ ]]; then
  logger -t cfanalisis-payments "CRON_SECRET missing or invalid"
  exit 1
fi

if ! PAYMENT_CRON_RESPONSE=$(
  printf 'header = "Authorization: Bearer %s"\n' "$PAYMENT_CRON_SECRET" \
    | curl --config - --fail --silent --show-error --max-time 55 \
      'http://127.0.0.1:3000/api/cron/payments'
); then
  logger -t cfanalisis-payments "reconciliation request failed"
  exit 1
fi

if [[ "$PAYMENT_CRON_RESPONSE" != *'"ok":true'* ]]; then
  logger -t cfanalisis-payments "reconciliation completed with provider errors"
  exit 1
fi
