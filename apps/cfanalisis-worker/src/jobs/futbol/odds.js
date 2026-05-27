// @ts-nocheck
/**
 * Job: futbol-odds
 *
 * Trae cuotas de The Odds API con PRESUPUESTO DIARIO de 7 llamadas (no cada
 * 15 min — eso quemaba los 500/mes en 1-2 días). Distribución:
 *   - Primera llamada: 2 horas ANTES del primer partido del día.
 *   - Resto: repartidas uniformemente hasta el último partido (spacing
 *     dinámico), hasta agotar el presupuesto de 7.
 *
 * El cron invoca este handler cada 30 min, pero el handler decide si gasta:
 * smart-skip si ya agotó el presupuesto, si aún no entra la ventana (2h pre
 * primer partido), o si no toca por el espaciado. Mismo patrón que el live de
 * baseball. No necesitamos ver cuotas cambiar en vivo todo el día.
 */
import { redisGet, redisSet, KEYS, getMatchSchedule, fetchOddsForFixtures, triggerEvent } from '../../shared.js';

const FINISHED = ['FT', 'AET', 'PEN', 'AWD', 'WO'];
// Ejecuciones/día (cada una trae TODAS las ligas con partidos). El límite DURO
// de requests vive en lib/odds-api.js (tope diario 15 req compartido fútbol+
// baseball → ≤450/mes). 2 ejecuciones: la 1ª (2h pre primer partido) trae la
// cuota inicial de todas las ligas; la 2ª una actualización más tarde si el
// tope de requests lo permite. Las cuotas son referencia, no críticas.
const ODDS_BUDGET = 2;
const PRE_FIRST_MATCH_MS = 2 * 3600 * 1000; // primera llamada 2h antes del 1er partido
const MIN_INTERVAL_MIN = 30;      // nunca más seguido que cada 30 min

const lastCallKey = 'odds:last-call:futbol';

export async function runOdds(_payload = {}) {
  if (!process.env.THE_ODDS_API_KEY) throw new Error('THE_ODDS_API_KEY not configured');

  const today = new Date().toISOString().split('T')[0];
  const quotaKey = `odds-quota:${today}`;
  const callsToday = Number(await redisGet(quotaKey)) || 0;
  const now = Date.now();

  // Presupuesto agotado → no más llamadas hoy.
  if (callsToday >= ODDS_BUDGET) {
    return { ok: true, skipped: true, reason: `budget exhausted (${callsToday}/${ODDS_BUDGET})` };
  }

  const fixtures = await redisGet(KEYS.fixtures(today));
  if (!fixtures || fixtures.length === 0) {
    return { ok: true, skipped: true, reason: 'no fixtures for today' };
  }
  const activeFixtures = fixtures.filter(f => !FINISHED.includes(f.fixture?.status?.short));
  if (activeFixtures.length === 0) {
    return { ok: true, skipped: true, reason: 'all matches finished' };
  }

  // Ventana de gasto: [primer partido − 2h, último partido].
  const schedule = (await redisGet(KEYS.schedule(today))) || (await getMatchSchedule(today).catch(() => null));
  const firstKickoff = schedule?.firstKickoff || null;
  const lastEnd = schedule?.lastExpectedEnd || null;
  const windowStart = firstKickoff ? firstKickoff - PRE_FIRST_MATCH_MS : now;

  if (firstKickoff && now < windowStart) {
    const minsTo = Math.round((windowStart - now) / 60000);
    return { ok: true, skipped: true, reason: `before odds window (${minsTo}min hasta 2h pre primer partido)` };
  }

  // Espaciado dinámico: repartir las llamadas restantes hasta el fin de la ventana.
  const windowEnd = lastEnd || (windowStart + 12 * 3600 * 1000);
  const callsRemaining = ODDS_BUDGET - callsToday;
  const minsUntilEnd = Math.max(1, (windowEnd - now) / 60000);
  const intervalMin = Math.max(MIN_INTERVAL_MIN, minsUntilEnd / callsRemaining);
  const lastCallAt = Number(await redisGet(lastCallKey)) || 0;
  if (lastCallAt && (now - lastCallAt) < intervalMin * 60000) {
    return {
      ok: true, skipped: true, reason: 'throttled',
      intervalMin: +intervalMin.toFixed(0), callsToday, callsRemaining,
      nextEligibleIn: Math.round((lastCallAt + intervalMin * 60000 - now) / 1000),
    };
  }

  // ── Gastar una llamada ──
  const { oddsByFixture, apiCallsUsed, remaining } = await fetchOddsForFixtures(activeFixtures);
  const matchedCount = Object.keys(oddsByFixture).length;

  await Promise.all(
    Object.entries(oddsByFixture).map(([fixtureId, odds]) =>
      redisSet(`odds:fixture:${fixtureId}`, { ...odds, fetchedAt: new Date().toISOString() }, 86400)
    )
  );
  await redisSet(`odds:date:${today}`, oddsByFixture, 86400).catch(() => {});
  await redisSet(quotaKey, callsToday + 1, 86400).catch(() => {});
  await redisSet(lastCallKey, String(now), 86400).catch(() => {});

  if (matchedCount > 0) {
    await triggerEvent('live-scores', 'odds-update', {
      date: today, odds: oddsByFixture, timestamp: new Date().toISOString(),
    });
  }

  console.log(`[job:futbol-odds] llamada ${callsToday + 1}/${ODDS_BUDGET} — matched=${matchedCount}/${activeFixtures.length} apiReqs=${apiCallsUsed} theOddsRestante=${remaining} intervalo=${intervalMin.toFixed(0)}min`);
  return {
    ok: true, matchedFixtures: matchedCount, totalActive: activeFixtures.length,
    apiCallsUsed, remaining, callsToday: callsToday + 1, budget: ODDS_BUDGET,
    intervalMin: +intervalMin.toFixed(0),
  };
}
