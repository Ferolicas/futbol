#!/usr/bin/env bash
# ============================================================================
# health_check.sh — chequeo periodico del worker.
#
# Instalar en /apps/scripts/health_check.sh con chmod +x.
# Cron sugerido (cada 5 min):
#   */5 * * * * /apps/scripts/health_check.sh >> /apps/scripts/health.log 2>&1
#
# Distingue UP, DEGRADED (dependencias/colas) y DOWN.
#
# Si esta DOWN, manda un mensaje al bot Telegram. Para evitar spam de alertas
# repetidas mientras el servicio sigue caido, usamos un archivo de estado.
# Solo se manda alerta cuando cambia el estado.
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

# ── Probe con reintentos (descarta blips de deploy) ─────────────────────
MAX_ATTEMPTS="${HEALTH_MAX_ATTEMPTS:-3}"
RETRY_DELAY="${HEALTH_RETRY_DELAY:-10}"
RESPONSE='000'
BODY=''
PROBE_STATE='down'
for attempt in $(seq 1 "${MAX_ATTEMPTS}"); do
  RESPONSE="$(curl -sS -o /tmp/cfanalisis_health_body -w '%{http_code}' \
                    --max-time 10 "${URL}" 2>/dev/null || echo '000')"
  BODY="$(cat /tmp/cfanalisis_health_body 2>/dev/null || echo '')"
  if [ "${RESPONSE}" = "200" ] && echo "${BODY}" | grep -q '"status":"ok"'; then
    PROBE_STATE='up'
    break
  fi
  if [ "${RESPONSE}" = "200" ] && echo "${BODY}" | grep -q '"status":"degraded"'; then
    PROBE_STATE='degraded'
    break
  fi
  if [ "${attempt}" -lt "${MAX_ATTEMPTS}" ]; then sleep "${RETRY_DELAY}"; fi
done

PREV_STATE="$(cat "${STATE_FILE}" 2>/dev/null || echo 'unknown')"
NEW_STATE="${PROBE_STATE}"
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
elif [ "${NEW_STATE}" = "degraded" ] && [ "${PREV_STATE}" != "degraded" ]; then
  SHORT="$(echo "${BODY}" | head -c 700 | tr -d '\n')"
  telegram "🟡" "<b>worker DEGRADED</b> ${URL}%0A${SHORT}"
  echo "[${TS}] DEGRADED ${SHORT}"
elif [ "${NEW_STATE}" = "up" ] && [ "${PREV_STATE}" = "down" ]; then
  telegram "🟢" "worker recovered ${URL}"
  echo "[${TS}] RECOVERED"
elif [ "${NEW_STATE}" = "up" ] && [ "${PREV_STATE}" = "degraded" ]; then
  telegram "🟢" "worker healthy again ${URL}"
  echo "[${TS}] HEALTHY AGAIN"
else
  # Estado estable — no alerta. Logueamos solo cuando hay cambio.
  echo "[${TS}] ${NEW_STATE}"
fi
