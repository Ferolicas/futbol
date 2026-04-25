/**
 * POST /api/cron/analyze-batch
 * Internal batch processor: analyzes a slice of fixtures and chains to the next batch.
 * Called internally by /api/cron/daily. NOT for direct use.
 *
 * After each batch of 10 it updates analysis:{date} in Redis so the frontend
 * can show partial progress while the chain is still running.
 */
import { analyzeMatch } from '../../../../lib/api-football';
import { getCachedFixturesRaw } from '../../../../lib/sanity-cache';
import { redisGet, redisSet } from '../../../../lib/redis';
import { triggerEvent } from '../../../../lib/pusher';
import { waitUntil } from '@vercel/functions';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const SAFETY_TIMEOUT_MS = 270 * 1000;
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

export async function POST(request) {
  const isInternal = request.headers.get('x-internal-trigger') === 'true';
  if (!isInternal && process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startTime = Date.now();

  try {
    const { offset, batchSize, date, totalFixtures } = await request.json();

    const allFixtures = await getCachedFixturesRaw(date);
    if (!allFixtures || allFixtures.length === 0) {
      return Response.json({ success: true, message: 'No fixtures in cache' });
    }

    const batch = allFixtures.slice(offset, offset + batchSize);
    if (batch.length === 0) {
      await _markComplete(date, totalFixtures || allFixtures.length);
      return Response.json({ success: true, message: 'All batches complete' });
    }

    console.log(`[ANALYZE-BATCH] Processing ${batch.length} matches (offset ${offset}/${allFixtures.length})`);

    const existing     = await redisGet(`analysis:${date}`) || { globallyAnalyzed: [], analyzedOdds: {}, analyzedData: {} };
    const analyzedIds  = existing.globallyAnalyzed || [];
    const analyzedOdds = existing.analyzedOdds || {};
    const analyzedData = existing.analyzedData || {};

    const persistProgress = () =>
      redisSet(`analysis:${date}`, { globallyAnalyzed: analyzedIds, analyzedOdds, analyzedData }, 12 * 3600).catch(() => {});

    let analyzed = 0, cached = 0, failed = 0;
    let processedInBatch = 0;
    let abortedEarly = false;
    let chainScheduled = false;

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

    // Schedule the next batch with a given offset. Idempotent — only fires once per request.
    const scheduleNextBatch = (nextOffset) => {
      if (chainScheduled) return;
      chainScheduled = true;
      waitUntil(
        fetch(`${baseUrl}/api/cron/analyze-batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-trigger': 'true' },
          body: JSON.stringify({ offset: nextOffset, batchSize, date, totalFixtures: allFixtures.length }),
        }).catch(e => console.error('[ANALYZE-BATCH] chain failed:', e.message))
      );
    };

    await Promise.all(batch.map(async (fixture) => {
      if (abortedEarly) return;
      if (Date.now() - startTime > SAFETY_TIMEOUT_MS) {
        abortedEarly = true;
        return;
      }

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

        processedInBatch++;
        if (processedInBatch % PERSIST_EVERY === 0) {
          await persistProgress();
        }
      } catch (e) {
        failed++;
        console.error(`[ANALYZE-BATCH] Failed ${fixture.fixture.id}:`, e.message);
      }
    }));

    await persistProgress();

    // If we hit the safety timeout, retry the SAME offset on the next instance.
    // Already-analyzed fixtures will return fromCache=true and breeze through.
    const nextOffset = abortedEarly ? offset : offset + batchSize;
    const hasMore    = nextOffset < allFixtures.length;

    await triggerEvent('analysis', 'batch-progress', {
      date,
      progress: `${Math.min(nextOffset, allFixtures.length)}/${allFixtures.length}`,
      analyzed, cached, failed, abortedEarly,
    }).catch(() => {});

    if (hasMore) {
      scheduleNextBatch(nextOffset);
    } else {
      await _markComplete(date, allFixtures.length);
    }

    return Response.json({
      success: true, analyzed, cached, failed, hasMore, abortedEarly,
      progress: `${Math.min(nextOffset, allFixtures.length)}/${allFixtures.length}`,
      totalAnalyzed: analyzedIds.length,
    });
  } catch (error) {
    console.error('[ANALYZE-BATCH] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

async function _markComplete(date, fixtureCount) {
  await redisSet(`dailyBatch:${date}`, {
    date, completed: true, fixtureCount,
    completedAt: new Date().toISOString(),
  }, 86400);
  console.log(`[ANALYZE-BATCH] All batches complete for ${date}`);
  await triggerEvent('analysis', 'batch-complete', {
    date, fixtureCount, timestamp: new Date().toISOString(),
  }).catch(() => {});
}
