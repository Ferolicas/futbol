// @ts-nocheck
/**
 * Job: futbol-odds
 *
 * Refresca las cuotas ricas de API-Football (Bet365/Bwin) después del análisis
 * nocturno. Las casas suelen publicar mercados estadísticos horas más tarde;
 * conservar la foto de T-24h dejaba partidos sin cuota aunque ya existiera en
 * Bet365. Revisa ayer/hoy/manana de Bogota y mantiene una vigilancia adaptativa
 * hasta el kickoff. Una respuesta vacia nunca cierra los reintentos.
 *
 * El job NO recalcula probabilidades. Sustituye únicamente las cuotas y vuelve
 * a construir las opciones con `_scored`/playerMarkets ya calculados.
 *
 * Payload: { date?: 'YYYY-MM-DD', force?: boolean, fixtureIds?: number[] }
 */
import {
  redisGet, redisSet, bogotaToday, getCachedFixturesRaw,
  getCachedAnalysis, cacheAnalysis, incrementApiCallCount,
  footballApiRequest, extractOdds, buildModelCombinada, buildFootballFinalVerdict,
  pgPool, triggerEvent,
} from '../../shared.js';
import { mapPool } from '../../pool.js';
import { logError } from '../../errors-log.js';
import { notifyError } from '../../notifier.js';
import oddsPolicy from './odds-policy.cjs';

const {
  HOUR_MS, scanDates, hasUsableOdds, catalogSize,
  refreshIntervalMs, shouldAttempt,
} = oddsPolicy;

const FINISHED = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO', 'CANC', 'ABD', 'PST']);
const PREMATCH = new Set(['NS', 'TBD']);
const REFRESH_CONCURRENCY = 8;

function refreshStateKey(date, fixtureId) {
  // v2 invalida los estados por fases que podian dar por terminada una
  // respuesta vacia y dejar el fixture sin otra consulta durante horas.
  return `football-odds-refresh-v2:${date}:${fixtureId}`;
}

async function rebuildWithOdds(existing, odds, fixture) {
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
  let finalVerdict = existing.finalVerdict;
  try {
    finalVerdict = await buildFootballFinalVerdict(pgPool, {
      fixture: {
        id: Number(fixture.fixture?.id),
        date: fixture.fixture?.date,
        season: fixture.league?.season,
        league: { id: fixture.league?.id, name: fixture.league?.name, season: fixture.league?.season },
        teams: fixture.teams,
      },
      odds,
    });
  } catch (error) {
    console.error(`[futbol-odds] finalVerdict ${fixture.fixture?.id}: ${error.message}`);
  }
  return {
    ...existing,
    odds,
    combinada,
    finalVerdict,
    oddsUpdatedAt: new Date().toISOString(),
  };
}

/** @param {any} payload */
export async function runOdds(payload = {}) {
  const dates = scanDates(bogotaToday(), payload.date);
  const force = payload.force === true;
  const requestedIds = new Set(
    (Array.isArray(payload.fixtureIds) ? payload.fixtureIds : [])
      .map(Number)
      .filter(id => Number.isInteger(id) && id > 0),
  );
  const now = Date.now();
  const fixtureDays = await Promise.all(dates.map(async date => ({
    date,
    fixtures: await getCachedFixturesRaw(date),
  })));
  if (!fixtureDays.some(day => Array.isArray(day.fixtures) && day.fixtures.length > 0)) {
    return { ok: true, skipped: true, reason: 'no fixtures for dates', dates };
  }

  const candidates = [];
  const seenFixtureIds = new Set();
  let noAnalysis = 0;
  for (const day of fixtureDays) {
    for (const fixture of (Array.isArray(day.fixtures) ? day.fixtures : [])) {
      const fixtureId = Number(fixture.fixture?.id);
      if (!fixtureId || seenFixtureIds.has(fixtureId) || (requestedIds.size && !requestedIds.has(fixtureId))) continue;
      seenFixtureIds.add(fixtureId);
      const status = fixture.fixture?.status?.short;
      if (FINISHED.has(status) || !PREMATCH.has(status)) continue;
      const kickoff = Date.parse(fixture.fixture?.date || '');
      const timeUntilKickoffMs = kickoff - now;
      // Ni siquiera un force manual puede convertir una cuota prepartido en
      // recomendacion cuando el encuentro ya comenzo.
      if (!Number.isFinite(kickoff) || timeUntilKickoffMs <= 0) continue;
      if (!force && !refreshIntervalMs(timeUntilKickoffMs, false)) continue;

      const existing = await getCachedAnalysis(fixtureId, day.date);
      if (!existing?._scored || typeof existing._scored !== 'object') {
        noAnalysis += 1;
        continue;
      }
      const storedHasOdds = hasUsableOdds(existing.odds);
      const intervalMs = refreshIntervalMs(timeUntilKickoffMs, storedHasOdds);
      if (!intervalMs && !force) continue;
      const stateKey = refreshStateKey(day.date, fixtureId);
      const state = force ? null : await redisGet(stateKey);
      if (!force && !shouldAttempt(state, now, intervalMs)) continue;
      candidates.push({
        date: day.date, fixture, fixtureId, existing, storedHasOdds,
        timeUntilKickoffMs, stateKey, state,
      });
    }
  }

  if (requestedIds.size && !candidates.length) {
    return { ok: true, skipped: true, reason: 'requested fixtures not eligible', dates, noAnalysis };
  }
  if (!candidates.length) {
    return { ok: true, skipped: true, reason: 'no odds refresh due', dates, noAnalysis };
  }

  let apiCalls = 0;
  let updated = 0;
  let noOdds = 0;
  const updatedFixtureIds = [];
  const criticalMissingFixtureIds = [];
  const errors = [];

  const results = await mapPool(candidates, REFRESH_CONCURRENCY, async (item) => {
    const {
      date, fixture, fixtureId, existing, storedHasOdds,
      timeUntilKickoffMs, stateKey, state,
    } = item;
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
      const critical = !storedHasOdds && timeUntilKickoffMs <= HOUR_MS;
      const criticalAlertedAt = state?.criticalAlertedAt || (critical ? new Date().toISOString() : null);
      await redisSet(stateKey, {
        hasOdds: storedHasOdds, attempts,
        lastAttemptAt: new Date().toISOString(),
        lastEmptyAt: new Date().toISOString(),
        criticalAlertedAt,
      }, 72 * 3600);
      if (critical) {
        criticalMissingFixtureIds.push(fixtureId);
        if (!state?.criticalAlertedAt) {
          const home = fixture.teams?.home?.name || 'Local';
          const away = fixture.teams?.away?.name || 'Visitante';
          await notifyError(
            { source: 'job', name: 'futbol-odds', extra: { fixtureId, date, check: 'critical-missing-odds' } },
            new Error(`Cuotas Bet365/Bwin ausentes a menos de 60 minutos: fixture ${fixtureId} (${home} vs ${away}). El reintento automatico sigue activo cada 15 minutos.`),
          ).catch(() => {});
        }
      }
      return { fixtureId, status: 'no-odds' };
    }

    const rebuilt = await rebuildWithOdds(existing, odds, fixture);
    if (!rebuilt) {
      noAnalysis += 1;
      // No marcar complete: cuando el análisis aparezca, el siguiente tick
      // debe poder aplicar las cuotas ya publicadas.
      await redisSet(stateKey, {
        complete: false, hasOdds: true, attempts,
        lastAttemptAt: new Date().toISOString(), reason: 'analysis-missing',
      }, 72 * 3600);
      return { fixtureId, status: 'no-analysis' };
    }

    const persist = await cacheAnalysis(fixtureId, rebuilt);
    if (persist?.db !== true) {
      throw new Error(`persistencia de cuotas falló: ${persist?.error || 'sin confirmación de PostgreSQL'}`);
    }
    await redisSet(stateKey, {
      hasOdds: true, attempts,
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      catalogSize: catalogSize(odds),
      selectable: rebuilt.combinada?.selectable?.length || 0,
      criticalAlertedAt: null,
    }, 72 * 3600);
    updated += 1;
    updatedFixtureIds.push(fixtureId);
    return { fixtureId, status: 'updated' };
  });

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.ok) continue;
    const item = candidates[index];
    errors.push({ fixtureId: item.fixtureId, error: result.error.message });
      await logError(item.date, {
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
      dates, fixtureIds: updatedFixtureIds, timestamp: new Date().toISOString(),
    }).catch(() => {});
  }

  if (errors.length > 0 && errors.length / candidates.length > 0.25) {
    throw new Error(`football odds refresh partial failure: ${errors.length}/${candidates.length}`);
  }

  return {
    ok: true, dates, checked: candidates.length, updated, noOdds, noAnalysis,
    criticalMissing: criticalMissingFixtureIds.length,
    criticalMissingFixtureIds,
    apiCalls, errors: errors.length, fixtureIds: updatedFixtureIds,
  };
}
