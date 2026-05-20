#!/usr/bin/env bash
# ============================================================================
# health_check.sh — chequeo periodico del worker.
#
# Cron (cada 5 min):
#   */5 * * * * /apps/scripts/health_check.sh >> /apps/scripts/health.log 2>&1
#
# UP si HTTP 200 y body contiene "status":"ok" (o "degraded").
# Reintenta la sonda antes de declarar DOWN, para no alertar por el parpadeo
# de ~3-5s de 'pm2 restart' en cada deploy. Ajustable via health.env:
#   HEALTH_MAX_ATTEMPTS (def 3), HEALTH_RETRY_DELAY seg (def 10).
# Solo alerta en transicion UP->DOWN o DOWN->UP (archivo de estado).
# ============================================================================

set -uo pipefail

ENV_FILE="/apps/scripts/health.env"
STATE_FILE="/tmp/cfanalisis_health_state"
URL="${HEALTH_URL:-https://worker.cfanalisis.com/health}"

if [ -f "${ENV_FILE}" ]; then
  set -a; source "${ENV_FILE}"; set +a
fi

telegram() {
  local emoji="$1"; shift
  local msg="$1"
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] telegram no configurado"
    return
  fi
  curl -fsS --max-time 10 \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "text=${emoji} cfanalisis: ${msg}" \
    -d "parse_mode=HTML" >/dev/null 2>&1 || true
}

# Probe con reintentos (descarta blips de deploy)
MAX_ATTEMPTS="${HEALTH_MAX_ATTEMPTS:-3}"
RETRY_DELAY="${HEALTH_RETRY_DELAY:-10}"
RESPONSE='000'
BODY=''
UP=0
for attempt in $(seq 1 "${MAX_ATTEMPTS}"); do
  RESPONSE="$(curl -sS -o /tmp/cfanalisis_health_body -w '%{http_code}' \
                    --max-time 10 "${URL}" 2>/dev/null || echo '000')"
  BODY="$(cat /tmp/cfanalisis_health_body 2>/dev/null || echo '')"
  if [ "${RESPONSE}" = "200" ] && echo "${BODY}" | grep -q '"status":"\(ok\|degraded\)"'; then
    UP=1
    break
  fi
  if [ "${attempt}" -lt "${MAX_ATTEMPTS}" ]; then
    sleep "${RETRY_DELAY}"
  fi
done

PREV_STATE="$(cat "${STATE_FILE}" 2>/dev/null || echo 'unknown')"
NEW_STATE="$([ "${UP}" = "1" ] && echo 'up' || echo 'down')"
echo "${NEW_STATE}" > "${STATE_FILE}"

TS="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

if [ "${NEW_STATE}" = "down" ] && [ "${PREV_STATE}" != "down" ]; then
  REASON="HTTP ${RESPONSE} (tras ${MAX_ATTEMPTS} intentos)"
  if [ -n "${BODY}" ]; then
    SHORT="$(echo "${BODY}" | head -c 200 | tr -d '\n')"
    REASON="${REASON} body=${SHORT}"
  fi
  telegram "🔴" "<b>worker DOWN</b> ${URL}%0A${REASON}"
  echo "[${TS}] DOWN ${REASON}"
elif [ "${NEW_STATE}" = "up" ] && [ "${PREV_STATE}" = "down" ]; then
  telegram "🟢" "worker recovered ${URL}"
  echo "[${TS}] RECOVERED"
else
  echo "[${TS}] ${NEW_STATE}"
fi
