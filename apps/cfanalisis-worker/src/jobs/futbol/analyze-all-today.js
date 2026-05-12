// @ts-nocheck
/**
 * Job: futbol-analyze-all-today
 * Port of /api/cron/analyze-all-today. Forces a fresh fetch + analysis of all
 * fixtures for a given date.
 *
 * Payload: { date?: string, force?: boolean }
 */
import { getFixtures, analyzeMatch, getQuota, getAnalyzedFixtureIds, redisSet } from '../../shared.js';

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

export async function runAnalyzeAllToday(payload = {}) {
  const date = payload.date || new Date().toISOString().split('T')[0];
  const forceAll = payload.force === true;
  const startTime = Date.now();

  const { fixtures } = await getFixtures(date, { forceApi: forceAll });
  const allFixtures = fixtures || [];

  if (allFixtures.length === 0) {
    return { ok: true, message: 'no fixtures', analyzed: 0, date };
  }

  const alreadyAnalyzed = forceAll ? [] : await getAnalyzedFixtureIds(date);
  const toAnalyze = forceAll ? allFixtures : allFixtures.filter(f => !alreadyAnalyzed.includes(f.fixture.id));

  if (toAnalyze.length === 0) {
    return { ok: true, message: 'all already analyzed', analyzed: 0, total: allFixtures.length, date };
  }

  const BATCH_SIZE = 3;
  const results = { success: 0, failed: 0, skipped: 0, errors: [] };
  const analyzedIds = [];
  const analyzedOdds = {};
  const analyzedData = {};

  for (let i = 0; i < toAnalyze.length; i += BATCH_SIZE) {
    const batch = toAnalyze.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (fixture) => {
      const fid = fixture.fixture.id;
      try {
        const result = await analyzeMatch(fixture, { date });
        if (!result || result.dataQuality === 'insufficient') {
          results.skipped++;
          return;
        }
        results.success++;
        const a = result.analysis || result;
        analyzedIds.push(fid);
        if (a?.odds?.matchWinner) analyzedOdds[fid] = a.odds.matchWinner;
        const summary = buildSummary(a);
        if (summary) analyzedData[fid] = summary;
      } catch (e) {
        console.error(`[job:futbol-analyze-all-today] fixture ${fid}:`, e.message);
        results.failed++;
        results.errors.push({ fixtureId: fid, error: e.message });
      }
    }));
    if (i + BATCH_SIZE < toAnalyze.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  if (analyzedIds.length > 0) {
    await redisSet(`analysis:${date}`, { globallyAnalyzed: analyzedIds, analyzedOdds, analyzedData }, 12 * 3600).catch(() => {});
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const quota = await getQuota();

  return {
    ok: true,
    date,
    total: allFixtures.length,
    analyzed: results.success,
    failed: results.failed,
    skipped: results.skipped,
    duration: `${duration}s`,
    quota,
    errors: results.errors.slice(0, 5),
  };
}
