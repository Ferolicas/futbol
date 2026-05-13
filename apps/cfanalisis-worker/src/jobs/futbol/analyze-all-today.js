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
  getAnalyzedFixtureIds, redisSet,
} from '../../shared.js';
import { mapPool } from '../../pool.js';
import { logError } from '../../errors-log.js';

const ANALYZE_CONCURRENCY = 25;

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
  };
}

/** @param {any} payload @param {any} [job] */
export async function runAnalyzeAllToday(payload = {}, job = null) {
  const date = payload.date || new Date().toISOString().split('T')[0];
  const forceAll = payload.force === true;
  const startTime = Date.now();
  const reportProgress = async (extra) => {
    if (!job?.updateProgress) return;
    try { await job.updateProgress(extra); } catch {}
  };

  const { fixtures } = await getFixtures(date, { forceApi: forceAll });
  const allFixtures = fixtures || [];

  if (allFixtures.length === 0) {
    return { ok: true, message: 'no fixtures', analyzed: 0, date };
  }

  const alreadyAnalyzed = forceAll ? [] : await getAnalyzedFixtureIds(date);
  const alreadySet = new Set(alreadyAnalyzed.map(Number));
  const toAnalyze = forceAll
    ? allFixtures
    : allFixtures.filter(f => !alreadySet.has(Number(f.fixture.id)));

  if (toAnalyze.length === 0) {
    return { ok: true, message: 'all already analyzed', analyzed: 0, total: allFixtures.length, date };
  }

  const analyzedIds = [];
  const analyzedOdds = {};
  const analyzedData = {};
  let success = 0, skipped = 0;
  let processed = 0;
  const errors = [];

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
    if (!result || result.dataQuality === 'insufficient') {
      processed++;
      await reportProgress({
        phase: 'analyzing', processed, total: toAnalyze.length,
        analyzed: success, skipped: skipped + 1, failed: errors.length, startedAt: startTime,
      });
      return { fid, kind: 'skip' };
    }
    const a = result.analysis || result;
    success++;
    analyzedIds.push(fid);
    if (a?.odds?.matchWinner) analyzedOdds[fid] = a.odds.matchWinner;
    const summary = buildSummary(a);
    if (summary) analyzedData[fid] = summary;
    processed++;
    await reportProgress({
      phase: 'analyzing', processed, total: toAnalyze.length,
      analyzed: success, skipped, failed: errors.length, startedAt: startTime,
    });
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

  if (analyzedIds.length > 0) {
    try {
      await redisSet(`analysis:${date}`, { globallyAnalyzed: analyzedIds, analyzedOdds, analyzedData }, 12 * 3600);
    } catch (e) {
      console.error('[job:futbol-analyze-all-today] persist:', e.message);
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
