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

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

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

    // Load current accumulated summary — built up across batches
    const existing     = await redisGet(`analysis:${date}`) || { globallyAnalyzed: [], analyzedOdds: {}, analyzedData: {} };
    const analyzedIds  = existing.globallyAnalyzed || [];
    const analyzedOdds = existing.analyzedOdds || {};
    const analyzedData = existing.analyzedData || {};

    let analyzed = 0, cached = 0, failed = 0;

    await Promise.all(batch.map(async (fixture) => {
      try {
        const result = await analyzeMatch(fixture, { date });
        if (!result) return;

        const a = result.analysis || result;
        const fid = fixture.fixture.id;

        if (result.fromCache) {
          cached++;
        } else {
          analyzed++;
        }

        // Update accumulated summary (whether from cache or freshly analyzed)
        if (!analyzedIds.includes(fid)) analyzedIds.push(fid);
        if (a?.odds?.matchWinner) analyzedOdds[fid] = a.odds.matchWinner;
        const summary = buildSummary(a);
        if (summary) analyzedData[fid] = summary;
      } catch (e) {
        failed++;
        console.error(`[ANALYZE-BATCH] Failed ${fixture.fixture.id}:`, e.message);
      }
    }));

    // Persist accumulated summary after every batch — frontend reads this on next request
    await redisSet(`analysis:${date}`, { globallyAnalyzed: analyzedIds, analyzedOdds, analyzedData }, 12 * 3600).catch(() => {});

    const nextOffset = offset + batchSize;
    const hasMore    = nextOffset < allFixtures.length;

    await triggerEvent('analysis', 'batch-progress', {
      date,
      progress: `${Math.min(offset + batchSize, allFixtures.length)}/${allFixtures.length}`,
      analyzed, cached, failed,
    }).catch(() => {});

    if (hasMore) {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL
        || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

      fetch(`${baseUrl}/api/cron/analyze-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-trigger': 'true' },
        body: JSON.stringify({ offset: nextOffset, batchSize, date, totalFixtures: allFixtures.length }),
      }).catch(() => {});
    } else {
      await _markComplete(date, allFixtures.length);
    }

    return Response.json({
      success: true, analyzed, cached, failed, hasMore,
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
