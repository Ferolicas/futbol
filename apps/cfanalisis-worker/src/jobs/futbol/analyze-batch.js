// @ts-nocheck
/**
 * Job: futbol-analyze-batch
 *
 * Analyzes every fixture for `date`. Uses a worker-pool (mapPool) so we
 * always keep ANALYZE_CONCURRENCY matches in flight; the shared rate
 * limiter inside lib/api-football.js (~9 req/s) is the real ceiling, not
 * batch alignment.
 *
 * Idempotent on retry: analyzeMatch returns `fromCache=true` for fixtures
 * already in Supabase, so re-runs are nearly free for the already-done
 * ones and only re-attempt the failures.
 *
 * If any fixture still has no analysis at the end, the job throws — BullMQ
 * retries with exponential backoff (see attempts in queues.ts). That
 * guarantees no match is silently dropped because the process died or
 * because the API hiccupped on one call.
 *
 * Payload: { date: 'YYYY-MM-DD' }
 */
import { UnrecoverableError } from 'bullmq';
import { analyzeMatch, getCachedFixturesRaw, redisGet, redisSet, triggerEvent } from '../../shared.js';
import { mapPool } from '../../pool.js';
import { logError } from '../../errors-log.js';

// API-Football Mega serializa todo a ~13 req/s vía el rate limiter compartido
// en lib/api-football.js. Más de ~10 análisis en paralelo no acelera nada —
// solo bloquea el event loop con trabajo CPU del motor (Dixon-Coles + stages
// 3-6) y dispara el "job stalled more than allowable limit" de BullMQ porque
// el setTimeout que renueva el lock no se logra ejecutar.
const ANALYZE_CONCURRENCY = 8;
const PERSIST_EVERY = 5;

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

async function markComplete(date, fixtureCount) {
  try {
    await redisSet(`dailyBatch:${date}`, {
      date, completed: true, fixtureCount,
      completedAt: new Date().toISOString(),
    }, 86400);
  } catch (e) {
    console.error('[job:futbol-analyze-batch] markComplete redis:', e.message);
  }
  try {
    await triggerEvent('analysis', 'batch-complete', {
      date, fixtureCount, timestamp: new Date().toISOString(),
    });
  } catch {}
}

/** @param {any} payload @param {any} [job] */
export async function runAnalyzeBatch(payload = {}, job = null) {
  const { date, force = false } = payload;
  // UnrecoverableError → BullMQ marca el job como failed inmediatamente sin
  // consumir los 5 attempts configurados en analyzeJobOpts. Reintentar un
  // payload invalido nunca lo arregla: es bug del caller, no fallo transitorio.
  if (!date) throw new UnrecoverableError('analyze-batch: date is required');
  const startedAt = Date.now();
  const reportProgress = async (extra) => {
    if (!job?.updateProgress) return;
    try { await job.updateProgress(extra); } catch {}
  };

  const allFixtures = await getCachedFixturesRaw(date);
  if (!allFixtures || allFixtures.length === 0) {
    return { ok: true, message: 'no fixtures in cache', date };
  }

  const existing     = (await redisGet(`analysis:${date}`)) || { globallyAnalyzed: [], analyzedOdds: {}, analyzedData: {} };
  const analyzedIds  = new Set((existing.globallyAnalyzed || []).map(Number));
  const analyzedOdds = { ...(existing.analyzedOdds || {}) };
  const analyzedData = { ...(existing.analyzedData || {}) };

  let analyzed = 0, cached = 0, processed = 0;
  const failedFids = [];
  // Persist tracking: separamos análisis OK pero BD-falló (persistFailedFids)
  // del fallo total (failedFids). Antes el job reportaba 99/99 OK aunque la
  // tabla match_analysis quedara vacía porque cacheAnalysis silenciaba errores.
  const persistFailedFids = [];
  let persistedDb = 0;
  let persistInFlight = null;

  // Debounced persistence: at most one Redis write in flight at a time,
  // each one captures a fresh snapshot. Race-safe because the body is
  // single-threaded; the worst case is a slightly-stale snapshot.
  const schedulePersist = () => {
    if (persistInFlight) return;
    persistInFlight = redisSet(`analysis:${date}`, {
      globallyAnalyzed: [...analyzedIds],
      analyzedOdds,
      analyzedData,
    }, 12 * 3600)
      .catch(e => console.error('[job:futbol-analyze-batch] persist:', e.message))
      .finally(() => { persistInFlight = null; });
  };

  await reportProgress({
    phase: 'analyzing', processed: 0, total: allFixtures.length,
    analyzed: 0, cached: 0, failed: 0, startedAt,
  });

  const results = await mapPool(allFixtures, ANALYZE_CONCURRENCY, async (fixture) => {
    const fid = Number(fixture.fixture.id);
    const result = await analyzeMatch(fixture, { date, force });
    if (!result) return { fid, skipped: true };

    const a = result.analysis || result;
    if (result.fromCache) cached++; else analyzed++;
    analyzedIds.add(fid);
    if (a?.odds?.matchWinner) analyzedOdds[fid] = a.odds.matchWinner;
    const summary = buildSummary(a);
    if (summary) analyzedData[fid] = summary;

    // Chequeo explícito de persistencia en match_analysis. result.persist viene
    // de cacheAnalysis ({ redis, db, error }). fromCache=true significa que el
    // análisis vino de BD/Redis previa, así que ya está persistido por
    // definición — no hace falta verificar.
    if (!result.fromCache) {
      const p = result.persist || { db: false, error: 'sin retorno' };
      if (p.db) {
        persistedDb++;
      } else {
        persistFailedFids.push(fid);
        console.error(`[job:futbol-analyze-batch] PERSIST FALLÓ fid=${fid}: ${p.error || 'unknown'}`);
      }
    } else {
      persistedDb++;
    }

    processed++;
    if (processed % PERSIST_EVERY === 0) schedulePersist();
    await reportProgress({
      phase: 'analyzing', processed, total: allFixtures.length,
      analyzed, cached, failed: failedFids.length, startedAt,
    });
    // Cede el event loop entre análisis: aunque el motor sea sync-pesado,
    // los timers de BullMQ (renew lock cada lockDuration/2) tienen oportunidad
    // de dispararse antes de que el siguiente análisis monopolice la CPU.
    await new Promise(r => setImmediate(r));
    return { fid, skipped: false };
  });

  // Collect failures (don't lose track of which fixtures didn't make it)
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.ok) {
      const fixture = allFixtures[i];
      const fid = Number(fixture.fixture.id);
      failedFids.push(fid);
      console.error(`[job:futbol-analyze-batch] failed ${fid}:`, r.error.message);
      // Persist a rich error entry for the /ferney dashboard
      await logError(date, {
        job: 'futbol-analyze-batch',
        fixtureId: fid,
        homeTeam: fixture.teams?.home?.name,
        awayTeam: fixture.teams?.away?.name,
        league: fixture.league?.name,
        kickoff: fixture.fixture?.date,
        error: r.error.message,
      });
    }
  }

  // Final persistence (await any in-flight write first, then one more snapshot)
  if (persistInFlight) await persistInFlight.catch(() => {});
  try {
    await redisSet(`analysis:${date}`, {
      globallyAnalyzed: [...analyzedIds],
      analyzedOdds,
      analyzedData,
    }, 12 * 3600);
  } catch (e) {
    console.error('[job:futbol-analyze-batch] final persist:', e.message);
  }

  try {
    await triggerEvent('analysis', 'batch-progress', {
      date,
      progress: `${analyzedIds.size}/${allFixtures.length}`,
      analyzed, cached, failed: failedFids.length,
    });
  } catch {}

  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  await reportProgress({
    phase: failedFids.length > 0 ? 'failed' : 'complete',
    processed: allFixtures.length, total: allFixtures.length,
    analyzed, cached, failed: failedFids.length, startedAt,
    durationSec: Number(durationSec),
  });

  // Resumen de persistencia en match_analysis (auditable en pm2 logs).
  console.log(
    `[job:futbol-analyze-batch] persistencia match_analysis: ` +
    `dbOk=${persistedDb}/${allFixtures.length} dbFail=${persistFailedFids.length}`,
  );

  // If ANY fixture failed (cálculo O persistencia), throw — BullMQ will retry
  // with backoff. On retry, analyzeMatch returns fromCache=true for completed
  // ones (sin reintentar el cálculo) y vuelve a intentar el upsert si la BD
  // falló antes. Antes solo se chequeaba failedFids (errores del motor), por
  // eso el job reportaba 99/99 OK mientras match_analysis quedaba en 0.
  const allFail = [...failedFids, ...persistFailedFids];
  if (allFail.length > 0) {
    const kind = failedFids.length > 0 ? 'analysis' : 'persist';
    console.error(
      `[job:futbol-analyze-batch] ${allFail.length}/${allFixtures.length} fixtures con fallo (${kind}) en ${durationSec}s — throwing for BullMQ retry`,
    );
    throw new Error(
      `analyze-batch incomplete: ${failedFids.length} análisis + ${persistFailedFids.length} persist failures ` +
      `(${allFail.slice(0, 10).join(',')}${allFail.length > 10 ? '…' : ''})`,
    );
  }

  await markComplete(date, allFixtures.length);

  return {
    ok: true,
    date,
    total: allFixtures.length,
    analyzed,
    cached,
    persistedDb,
    failed: 0,
    durationSec: Number(durationSec),
    concurrency: ANALYZE_CONCURRENCY,
  };
}
