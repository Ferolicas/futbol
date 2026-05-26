// @ts-nocheck
/**
 * Job: futbol-analyze-all-today
 *
 * Force-refresh path: fetches fixtures from API directly (bypassing the
 * daily cache when `force=true`) and analyzes any that aren't yet in
 * Supabase. Uses the same worker-pool concurrency model as analyze-batch.
 *
 * Throws on any partial failure → BullMQ retries; cached fixtures
 * short-circuit on the next attempt.
 *
 * Payload: { date?: string, force?: boolean }
 */
import {
  getFixtures, analyzeMatch, getQuota,
  getAnalyzedFixtureIds, redisGet, redisSet, bogotaToday,
} from '../../shared.js';
import { mapPool } from '../../pool.js';
import { logError } from '../../errors-log.js';

// API-Football Ultra serializa a ~13 req/s vía el rate limiter de
// lib/api-football.js. Más de ~10 en paralelo solo bloquea el event loop
// con trabajo CPU del motor (Dixon-Coles + stages 3-6) y dispara stalls
// porque el lock renewer de BullMQ no logra ejecutarse.
const ANALYZE_CONCURRENCY = 8;
// Persistir el agregado cada N análisis para que si el job stall, no se
// pierda el progreso entero (el motor ya cachea cada análisis individual
// vía analyzeMatch; lo que se reconstruye aquí es el set agregado del día).
const PERSIST_EVERY = 10;

function compactLastFive(lastFive) {
  if (!Array.isArray(lastFive)) return [];
  return lastFive.map(m => {
    const e = m._enriched || {};
    return {
      r: e.result, s: e.score, gF: e.goalsFor, gA: e.goalsAgainst,
      op: e.opponentName, oL: e.opponentLogo,
      c: e.corners, y: e.yellowCards, rd: e.redCards,
    };
  });
}

function buildSummary(a) {
  if (!a) return null;
  return {
    fixtureId: a.fixtureId, homeTeam: a.homeTeam, awayTeam: a.awayTeam,
    homeLogo: a.homeLogo, awayLogo: a.awayLogo, homeId: a.homeId, awayId: a.awayId,
    league: a.league, leagueId: a.leagueId, leagueLogo: a.leagueLogo,
    kickoff: a.kickoff, status: a.status, goals: a.goals, odds: a.odds,
    combinada: a.combinada, calculatedProbabilities: a.calculatedProbabilities,
    homePosition: a.homePosition, awayPosition: a.awayPosition,
    homeLastFive: compactLastFive(a.homeLastFive),
    awayLastFive: compactLastFive(a.awayLastFive),
    playerHighlights: a.playerHighlights || null,
    referee: a.referee || null,
    refereeStats: a.refereeStats || null,
  };
}

/** @param {any} payload @param {any} [job] */
export async function runAnalyzeAllToday(payload = {}, job = null) {
  // Uso MANUAL (botón "Re-analizar"): el día Bogotá ACTUAL (no el del cron, que
  // prepara el día siguiente de noche). Si el frontend pasa una fecha explícita
  // (la del día que el usuario está viendo) se respeta; si no, hoy en Bogotá.
  const date = payload.date || bogotaToday();
  const forceAll = payload.force === true;
  const startTime = Date.now();
  console.log(`[analyze-all-today] start date=${date} force=${forceAll}`);
  const reportProgress = async (extra) => {
    if (!job?.updateProgress) return;
    try { await job.updateProgress(extra); } catch {}
  };

  // OJO: NO pasamos forceApi:forceAll. La cache de fixtures se refresca por
  // el cron `futbol-fixtures` a las 0:05 y por el staleness check interno
  // de getFixtures (>2.5h sin actualizar partidos live). Re-pedir la lista
  // a API-Football en cada "Re-analizar todo" añadía ~5-15s de latencia
  // antes del primer análisis (la response global del día son varios MB,
  // se filtra en JS, y compite por el rate limiter con jobs paralelos).
  // El `force=true` se sigue propagando a analyzeMatch para que el motor
  // re-corra ignorando el cache de análisis.
  const tFixtures = Date.now();
  const { fixtures } = await getFixtures(date);
  console.log(`[analyze-all-today] getFixtures took ${Date.now() - tFixtures}ms`);
  const allFixtures = fixtures || [];

  if (allFixtures.length === 0) {
    return { ok: true, message: 'no fixtures', analyzed: 0, date };
  }

  const tAlready = Date.now();
  const alreadyAnalyzed = forceAll ? [] : await getAnalyzedFixtureIds(date);
  const alreadySet = new Set(alreadyAnalyzed.map(Number));
  const toAnalyze = forceAll
    ? allFixtures
    : allFixtures.filter(f => !alreadySet.has(Number(f.fixture.id)));
  console.log(`[analyze-all-today] toAnalyze=${toAnalyze.length}/${allFixtures.length} (already=${alreadyAnalyzed.length}) lookup=${Date.now() - tAlready}ms`);

  if (toAnalyze.length === 0) {
    return { ok: true, message: 'all already analyzed', analyzed: 0, total: allFixtures.length, date };
  }

  // SIEMPRE arrancar con el set existente — aunque sea forceAll. Si el
  // job stallea o falla a mitad, los análisis previos NO se pierden. Los
  // datos individuales (odds, summary) sí se sobrescriben cuando este job
  // re-analiza el fixture (analyzeMatch con force=true devuelve datos nuevos),
  // pero un fixture analizado y no re-procesado mantiene su entrada.
  //
  // Razón de UX: el usuario presiona "Re-analizar todo" esperando que NUNCA
  // queden partidos sin analizar. Empezar de cero hace lo contrario: borra
  // 99 análisis válidos en el primer instante; si algo falla, queda peor que
  // antes. Con UNION, el peor caso es "algunos quedan con análisis viejo",
  // mucho mejor que "algunos desaparecen".
  const existing = (await redisGet(`analysis:${date}`)) || { globallyAnalyzed: [], analyzedOdds: {}, analyzedData: {} };
  const analyzedIdsSet = new Set((existing.globallyAnalyzed || []).map(Number));
  const analyzedOdds = { ...(existing.analyzedOdds || {}) };
  const analyzedData = { ...(existing.analyzedData || {}) };
  let success = 0, skipped = 0;
  let processed = 0;
  const errors = [];

  // Debounced persist: a lo sumo un write Redis en vuelo. Cada N análisis
  // disparamos un snapshot. Si el job stallea, el agregado parcial sobrevive.
  let persistInFlight = null;
  const schedulePersist = () => {
    if (persistInFlight) return;
    persistInFlight = redisSet(`analysis:${date}`, {
      globallyAnalyzed: [...analyzedIdsSet],
      analyzedOdds,
      analyzedData,
    }, 12 * 3600)
      .catch(e => console.error('[job:futbol-analyze-all-today] persist:', e.message))
      .finally(() => { persistInFlight = null; });
  };

  await reportProgress({
    phase: 'analyzing', processed: 0, total: toAnalyze.length,
    analyzed: 0, skipped: 0, failed: 0, startedAt: startTime,
  });

  const results = await mapPool(toAnalyze, ANALYZE_CONCURRENCY, async (fixture) => {
    const fid = Number(fixture.fixture.id);
    // Pasar force a analyzeMatch — si no, analyzeMatch devuelve el análisis
    // cacheado en Supabase/Redis y la re-analizacion no hace nada (termina
    // en 1 seg porque solo lee de cache).
    const result = await analyzeMatch(fixture, { date, force: forceAll });
    // ⚠️ NO skipeamos si dataQuality='insufficient' — el modelo usa fallbacks
    // (lambda=1.2 etc.) y produce probabilidades aproximadas. El frontend
    // muestra la advertencia "Datos limitados" en esos partidos. Si los
    // skipeamos, quedan eternamente como "pendientes" en /ferney aunque
    // el usuario presione "Re-analizar todos". Mejor analizar partial que
    // dejar el partido sin analisis.
    if (!result) {
      processed++;
      await reportProgress({
        phase: 'analyzing', processed, total: toAnalyze.length,
        analyzed: success, skipped: skipped + 1, failed: errors.length, startedAt: startTime,
      });
      await new Promise(r => setImmediate(r));
      return { fid, kind: 'skip' };
    }
    const a = result.analysis || result;
    success++;
    analyzedIdsSet.add(fid);
    if (a?.odds?.matchWinner) analyzedOdds[fid] = a.odds.matchWinner;
    const summary = buildSummary(a);
    if (summary) analyzedData[fid] = summary;
    processed++;
    if (processed % PERSIST_EVERY === 0) schedulePersist();
    await reportProgress({
      phase: 'analyzing', processed, total: toAnalyze.length,
      analyzed: success, skipped, failed: errors.length, startedAt: startTime,
    });
    // Cede el event loop entre análisis: el lock renewer de BullMQ
    // (setTimeout cada lockDuration/2) puede dispararse aunque el motor
    // del próximo análisis sea CPU-pesado.
    await new Promise(r => setImmediate(r));
    return { fid, kind: 'ok' };
  });

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.ok) {
      if (r.value.kind === 'skip') skipped++;
    } else {
      const fixture = toAnalyze[i];
      const fid = Number(fixture.fixture.id);
      errors.push({ fixtureId: fid, error: r.error.message });
      console.error(`[job:futbol-analyze-all-today] failed ${fid}:`, r.error.message);
      await logError(date, {
        job: 'futbol-analyze-all-today',
        fixtureId: fid,
        homeTeam: fixture.teams?.home?.name,
        awayTeam: fixture.teams?.away?.name,
        league: fixture.league?.name,
        kickoff: fixture.fixture?.date,
        error: r.error.message,
      });
    }
  }

  // Asegurar que el último snapshot quede persistido (espera el debounce
  // en vuelo si lo hay y hace una última escritura con el set completo).
  if (persistInFlight) await persistInFlight.catch(() => {});
  if (analyzedIdsSet.size > 0) {
    try {
      await redisSet(`analysis:${date}`, {
        globallyAnalyzed: [...analyzedIdsSet],
        analyzedOdds,
        analyzedData,
      }, 12 * 3600);
    } catch (e) {
      console.error('[job:futbol-analyze-all-today] final persist:', e.message);
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const quota = await getQuota().catch(() => null);

  if (errors.length > 0) {
    throw new Error(`analyze-all-today incomplete: ${errors.length} failures in ${durationSec}s`);
  }

  return {
    ok: true,
    date,
    total: allFixtures.length,
    analyzed: success,
    skipped,
    durationSec: Number(durationSec),
    concurrency: ANALYZE_CONCURRENCY,
    quota,
  };
}
