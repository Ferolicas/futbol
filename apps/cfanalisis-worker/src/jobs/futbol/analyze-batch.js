// @ts-nocheck
/**
 * Job: futbol-analyze-batch
 * Port of /api/cron/analyze-batch. Since the worker has no time limit, this
 * version analyzes ALL remaining fixtures in a single job (no HTTP chaining
 * via waitUntil), persisting progress to Redis every PERSIST_EVERY matches.
 *
 * Payload: { offset?: number, batchSize?: number, date: string, totalFixtures?: number }
 */
import { analyzeMatch } from '../../../../../lib/api-football.js';
import { getCachedFixturesRaw } from '../../../../../lib/sanity-cache.js';
import { redisGet, redisSet } from '../../../../../lib/redis.js';
import { triggerEvent } from '../../../../../lib/pusher.js';

const PERSIST_EVERY = 3;

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

async function markComplete(date, fixtureCount) {
  await redisSet(`dailyBatch:${date}`, {
    date, completed: true, fixtureCount,
    completedAt: new Date().toISOString(),
  }, 86400);
  await triggerEvent('analysis', 'batch-complete', {
    date, fixtureCount, timestamp: new Date().toISOString(),
  }).catch(() => {});
}

export async function runAnalyzeBatch(payload = {}) {
  const { date } = payload;
  if (!date) throw new Error('analyze-batch: date is required');
  const startOffset = Number(payload.offset || 0);
  const batchSize   = Number(payload.batchSize || 10);

  const allFixtures = await getCachedFixturesRaw(date);
  if (!allFixtures || allFixtures.length === 0) {
    return { ok: true, message: 'no fixtures in cache', date };
  }

  const existing     = (await redisGet(`analysis:${date}`)) || { globallyAnalyzed: [], analyzedOdds: {}, analyzedData: {} };
  const analyzedIds  = existing.globallyAnalyzed || [];
  const analyzedOdds = existing.analyzedOdds || {};
  const analyzedData = existing.analyzedData || {};

  const persistProgress = () =>
    redisSet(`analysis:${date}`, { globallyAnalyzed: analyzedIds, analyzedOdds, analyzedData }, 12 * 3600).catch(() => {});

  let analyzed = 0, cached = 0, failed = 0;
  let processedTotal = 0;

  // No Vercel time limit — process the whole tail of the list in batches.
  for (let offset = startOffset; offset < allFixtures.length; offset += batchSize) {
    const batch = allFixtures.slice(offset, offset + batchSize);

    await Promise.all(batch.map(async (fixture) => {
      try {
        const result = await analyzeMatch(fixture, { date });
        if (!result) return;

        const a = result.analysis || result;
        const fid = fixture.fixture.id;

        if (result.fromCache) cached++;
        else analyzed++;

        if (!analyzedIds.includes(fid)) analyzedIds.push(fid);
        if (a?.odds?.matchWinner) analyzedOdds[fid] = a.odds.matchWinner;
        const summary = buildSummary(a);
        if (summary) analyzedData[fid] = summary;

        processedTotal++;
        if (processedTotal % PERSIST_EVERY === 0) {
          await persistProgress();
        }
      } catch (e) {
        failed++;
        console.error(`[job:futbol-analyze-batch] failed ${fixture.fixture.id}:`, e.message);
      }
    }));

    await persistProgress();

    await triggerEvent('analysis', 'batch-progress', {
      date,
      progress: `${Math.min(offset + batchSize, allFixtures.length)}/${allFixtures.length}`,
      analyzed, cached, failed,
    }).catch(() => {});
  }

  await markComplete(date, allFixtures.length);

  return {
    ok: true,
    date,
    analyzed, cached, failed,
    totalAnalyzed: analyzedIds.length,
    total: allFixtures.length,
  };
}
