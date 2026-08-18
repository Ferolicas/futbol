// @ts-nocheck
/**
 * Job: futbol-odds
 *
 * Refresca las cuotas ricas de API-Football (Bet365/Bwin) después del análisis
 * nocturno. Las casas suelen publicar mercados estadísticos horas más tarde;
 * conservar la foto de T-24h dejaba partidos sin cuota aunque ya existiera en
 * Bet365. Cada fixture tiene tres fases idempotentes: T-12h, T-3h y T-60m.
 *
 * El job NO recalcula probabilidades. Sustituye únicamente las cuotas y vuelve
 * a construir las opciones con `_scored`/playerMarkets ya calculados.
 *
 * Payload: { date?: 'YYYY-MM-DD', force?: boolean, fixtureIds?: number[] }
 */
import {
  redisGet, redisSet, KEYS, bogotaToday,
  getCachedAnalysis, cacheAnalysis, incrementApiCallCount,
  footballApiRequest, extractOdds, buildModelCombinada, triggerEvent,
} from '../../shared.js';
import { mapPool } from '../../pool.js';
import { logError } from '../../errors-log.js';

const FINISHED = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO', 'CANC', 'ABD', 'PST']);
const HOUR_MS = 60 * 60 * 1000;
const EMPTY_RETRY_MS = 30 * 60 * 1000;
const MAX_EMPTY_ATTEMPTS_PER_PHASE = 4;
const REFRESH_CONCURRENCY = 8;

// Una fase nueva siempre vuelve a consultar, aunque una fase anterior ya haya
// encontrado cuotas: Bet365 añade props/líneas al acercarse el kickoff.
export function oddsRefreshPhase(timeUntilKickoffMs) {
  if (!Number.isFinite(timeUntilKickoffMs) || timeUntilKickoffMs <= 0 || timeUntilKickoffMs > 12 * HOUR_MS) return null;
  if (timeUntilKickoffMs <= HOUR_MS) return 'final';
  if (timeUntilKickoffMs <= 3 * HOUR_MS) return 'pregame';
  return 'early';
}

function refreshStateKey(date, fixtureId, phase) {
  return `football-odds-refresh:${date}:${fixtureId}:${phase}`;
}

function shouldRetryEmpty(state, now) {
  if (!state || state.complete !== true) return true;
  if (state.hasOdds) return false;
  if (Number(state.attempts || 0) >= MAX_EMPTY_ATTEMPTS_PER_PHASE) return false;
  const lastAttempt = Date.parse(state.lastAttemptAt || '');
  return !Number.isFinite(lastAttempt) || now - lastAttempt >= EMPTY_RETRY_MS;
}

function rebuildWithOdds(existing, odds) {
  if (!existing?._scored || typeof existing._scored !== 'object') return null;
  const teamNames = {
    home: existing.homeTeam,
    away: existing.awayTeam,
    homeId: existing.homeId,
    awayId: existing.awayId,
  };
  const combinada = buildModelCombinada(
    existing._scored,
    odds,
    teamNames,
    existing.playerMarkets || {},
    existing.calculatedProbabilities || {},
    existing.cornerCardData || null,
  );
  return {
    ...existing,
    odds,
    combinada,
    oddsUpdatedAt: new Date().toISOString(),
  };
}

/** @param {any} payload */
export async function runOdds(payload = {}) {
  const date = payload.date || bogotaToday();
  const force = payload.force === true;
  const requestedIds = new Set(
    (Array.isArray(payload.fixtureIds) ? payload.fixtureIds : [])
      .map(Number)
      .filter(id => Number.isInteger(id) && id > 0),
  );
  const now = Date.now();
  const fixtures = await redisGet(KEYS.fixtures(date));
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    return { ok: true, skipped: true, reason: 'no fixtures for date', date };
  }

  const candidates = [];
  for (const fixture of fixtures) {
    const fixtureId = Number(fixture.fixture?.id);
    if (!fixtureId || (requestedIds.size && !requestedIds.has(fixtureId))) continue;
    if (FINISHED.has(fixture.fixture?.status?.short)) continue;
    const kickoff = Date.parse(fixture.fixture?.date || '');
    const phase = force ? 'manual' : oddsRefreshPhase(kickoff - now);
    if (!phase) continue;
    const stateKey = refreshStateKey(date, fixtureId, phase);
    const state = force ? null : await redisGet(stateKey);
    if (!force && !shouldRetryEmpty(state, now)) continue;
    candidates.push({ fixture, fixtureId, phase, stateKey, state });
  }

  if (requestedIds.size && !candidates.length) {
    return { ok: true, skipped: true, reason: 'requested fixtures not eligible', date };
  }
  if (!candidates.length) {
    return { ok: true, skipped: true, reason: 'no refresh phase due', date };
  }

  let apiCalls = 0;
  let updated = 0;
  let noOdds = 0;
  let noAnalysis = 0;
  const updatedFixtureIds = [];
  const errors = [];

  const results = await mapPool(candidates, REFRESH_CONCURRENCY, async (item) => {
    const { fixture, fixtureId, phase, stateKey, state } = item;
    const response = await footballApiRequest(`/odds?fixture=${fixtureId}`, {
      apiKey: process.env.FOOTBALL_API_KEY,
      timeoutMs: 20_000,
      retries: 2,
    });
    apiCalls += 1;
    const odds = extractOdds(response.response);
    const attempts = Number(state?.attempts || 0) + 1;
    if (!odds) {
      noOdds += 1;
      await redisSet(stateKey, {
        complete: true, hasOdds: false, attempts,
        lastAttemptAt: new Date().toISOString(), phase,
      }, 36 * 3600);
      return { fixtureId, status: 'no-odds' };
    }

    const existing = await getCachedAnalysis(fixtureId, date);
    const rebuilt = rebuildWithOdds(existing, odds);
    if (!rebuilt) {
      noAnalysis += 1;
      // No marcar complete: cuando el análisis aparezca, el siguiente tick
      // debe poder aplicar las cuotas ya publicadas.
      await redisSet(stateKey, {
        complete: false, hasOdds: true, attempts,
        lastAttemptAt: new Date().toISOString(), phase, reason: 'analysis-missing',
      }, 36 * 3600);
      return { fixtureId, status: 'no-analysis' };
    }

    const persist = await cacheAnalysis(fixtureId, rebuilt);
    if (persist?.db !== true) {
      throw new Error(`persistencia de cuotas falló: ${persist?.error || 'sin confirmación de PostgreSQL'}`);
    }
    await redisSet(stateKey, {
      complete: true, hasOdds: true, attempts,
      lastAttemptAt: new Date().toISOString(), phase,
      selectable: rebuilt.combinada?.selectable?.length || 0,
    }, 36 * 3600);
    updated += 1;
    updatedFixtureIds.push(fixtureId);
    return { fixtureId, status: 'updated' };
  });

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.ok) continue;
    const item = candidates[index];
    errors.push({ fixtureId: item.fixtureId, error: result.error.message });
    await logError(date, {
      job: 'futbol-odds', fixtureId: item.fixtureId,
      homeTeam: item.fixture.teams?.home?.name,
      awayTeam: item.fixture.teams?.away?.name,
      league: item.fixture.league?.name,
      kickoff: item.fixture.fixture?.date,
      error: result.error.message,
    }).catch(() => {});
  }

  if (apiCalls > 0) await incrementApiCallCount(apiCalls);
  if (updatedFixtureIds.length > 0) {
    await triggerEvent('match-updates', 'odds-ready', {
      date, fixtureIds: updatedFixtureIds, timestamp: new Date().toISOString(),
    }).catch(() => {});
  }

  if (errors.length > 0 && errors.length / candidates.length > 0.25) {
    throw new Error(`football odds refresh partial failure: ${errors.length}/${candidates.length}`);
  }

  return {
    ok: true, date, checked: candidates.length, updated, noOdds, noAnalysis,
    apiCalls, errors: errors.length, fixtureIds: updatedFixtureIds,
  };
}
