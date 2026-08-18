'use strict';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const LOOKAHEAD_MS = 36 * HOUR_MS;

function addCalendarDays(dateStr, days) {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) return null;
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function scanDates(today, explicitDate) {
  if (explicitDate) return [explicitDate];
  // Hoy y manana primero para que una copia residual del fixture en el cache
  // de ayer no gane la deduplicacion por ID.
  return [0, 1, -1]
    .map(offset => addCalendarDays(today, offset))
    .filter(Boolean);
}

function hasUsableOdds(odds) {
  if (!odds || typeof odds !== 'object') return false;
  const books = Array.isArray(odds.allBookmakerOdds) ? odds.allBookmakerOdds : [];
  if (books.some(book => book && typeof book === 'object' && Object.keys(book).length > 2)) return true;
  return Object.entries(odds).some(([key, value]) => (
    !['bookmaker', 'allowedOnly', 'source', 'fetchedAt', 'allBookmakerOdds'].includes(key)
    && value && typeof value === 'object' && Object.keys(value).length > 0
  ));
}

function catalogSize(odds) {
  if (!hasUsableOdds(odds)) return 0;
  const roots = Array.isArray(odds.allBookmakerOdds) && odds.allBookmakerOdds.length
    ? odds.allBookmakerOdds
    : [odds];
  let count = 0;
  const visit = (value, key = '') => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 1 && key !== 'id') {
      count += 1;
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  };
  roots.forEach(root => visit(root));
  return count;
}

/**
 * Cadencia adaptativa. Una respuesta vacia nunca se marca como terminada:
 * vuelve a intentarse hasta el kickoff. Cuando ya existen cuotas tambien se
 * refrescan con mas frecuencia al acercarse el partido para capturar mercados
 * y lineas que Bet365 publica tarde.
 */
function refreshIntervalMs(timeUntilKickoffMs, hasOdds) {
  if (!Number.isFinite(timeUntilKickoffMs)
      || timeUntilKickoffMs <= 0
      || timeUntilKickoffMs > LOOKAHEAD_MS) return null;

  if (!hasOdds) {
    if (timeUntilKickoffMs <= 3 * HOUR_MS) return 15 * MINUTE_MS;
    if (timeUntilKickoffMs <= 12 * HOUR_MS) return 30 * MINUTE_MS;
    return HOUR_MS;
  }

  if (timeUntilKickoffMs <= HOUR_MS) return 15 * MINUTE_MS;
  if (timeUntilKickoffMs <= 3 * HOUR_MS) return 30 * MINUTE_MS;
  if (timeUntilKickoffMs <= 12 * HOUR_MS) return 3 * HOUR_MS;
  return 6 * HOUR_MS;
}

function shouldAttempt(state, nowMs, intervalMs) {
  if (!intervalMs) return false;
  const lastAttemptMs = Date.parse(state?.lastAttemptAt || '');
  return !Number.isFinite(lastAttemptMs) || nowMs - lastAttemptMs >= intervalMs;
}

module.exports = {
  MINUTE_MS,
  HOUR_MS,
  LOOKAHEAD_MS,
  addCalendarDays,
  scanDates,
  hasUsableOdds,
  catalogSize,
  refreshIntervalMs,
  shouldAttempt,
};
