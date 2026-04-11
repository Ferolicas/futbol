import { analyzeMatch, getFixtures, fetchMatchStats, resetRateLimiter } from '../../../../lib/api-football';
import { getCachedAnalysis, getAnalyzedMatchesFull } from '../../../../lib/sanity-cache';
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../../lib/supabase';
import { redisGet, redisDel, redisSet, KEYS, TTL } from '../../../../lib/redis';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const OWNER_EMAIL = 'ferneyolicas@gmail.com';
const BATCH_SIZE = 10;

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
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (user.email?.toLowerCase() !== OWNER_EMAIL) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const today = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const force = searchParams.get('force') === 'true';
  const offset = parseInt(searchParams.get('offset') || '0', 10);

  let allFixtures = null;

  // First batch (offset=0): clear caches and fetch fresh fixtures from API
  if (offset === 0) {
    const existingFixtures = await redisGet(KEYS.fixtures(today));
    const fidsToClear = Array.isArray(existingFixtures)
      ? existingFixtures.map(f => f.fixture?.id).filter(Boolean)
      : [];

    await Promise.all([
      redisDel(`analysis:${today}`),
      redisDel(KEYS.fixtures(today)),
      ...fidsToClear.map(fid => redisDel(`analysis:fixture:${fid}`)),
    ]);

    // Reset rate limiter on first batch
    resetRateLimiter();

    // Fetch fresh fixtures and cache them
    let fetchedFixtures = null;
    try {
      const result = await getFixtures(today, { forceApi: true });
      fetchedFixtures = result.fixtures || [];
    } catch {}

    if (!fetchedFixtures || fetchedFixtures.length === 0) {
      return Response.json({ success: true, analyzed: 0, total: 0, hasMore: false, message: 'No fixtures for this date' });
    }

    await redisSet(KEYS.fixtures(today), fetchedFixtures, 48 * 3600).catch(() => {});
    await redisSet(`analysis:${today}`, { globallyAnalyzed: [], analyzedOdds: {}, analyzedData: {} }, 12 * 3600).catch(() => {});

    allFixtures = fetchedFixtures; // use in-memory — don't re-read Redis
  } else {
    // offset > 0: load fixtures from Redis
    allFixtures = await redisGet(KEYS.fixtures(today));
    if (!Array.isArray(allFixtures) || allFixtures.length === 0) {
      return Response.json({ error: 'Fixtures not in cache — restart from offset 0' }, { status: 400 });
    }
  }

  const total = allFixtures.length;
  const batch = allFixtures.slice(offset, offset + BATCH_SIZE);

  if (batch.length === 0) {
    return Response.json({ success: true, analyzed: 0, total, offset, hasMore: false });
  }

  // Load current accumulated analysis cache (built up across batches)
  const existing = await redisGet(`analysis:${today}`) || { globallyAnalyzed: [], analyzedOdds: {}, analyzedData: {} };
  const analyzedIds = existing.globallyAnalyzed || [];
  const analyzedOdds = existing.analyzedOdds || {};
  const analyzedData = existing.analyzedData || {};

  let analyzed = 0, skipped = 0, failed = 0;

  for (const fixture of batch) {
    const fid = fixture.fixture?.id;
    const name = `${fixture.teams?.home?.name || '?'} vs ${fixture.teams?.away?.name || '?'}`;
    let result = null;
    let lastErr = null;

    // Up to 3 attempts per fixture
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await analyzeMatch(fixture, { date: today, force });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`[reanalyze] Attempt ${attempt + 1} failed for ${fid} (${name}): ${e.message}`);
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }

    if (result) {
      const a = result.analysis || result;
      analyzed++;
      analyzedIds.push(fid);
      if (a.odds?.matchWinner) analyzedOdds[fid] = a.odds.matchWinner;
      analyzedData[fid] = buildSummary(a);
    } else {
      failed++;
      console.error(`[reanalyze] All attempts failed for ${fid} (${name}):`, lastErr?.message);
    }
  }

  // Persist accumulated progress — safe even if next batch request never comes
  await redisSet(`analysis:${today}`, { globallyAnalyzed: analyzedIds, analyzedOdds, analyzedData }, 12 * 3600).catch(() => {});

  const nextOffset = offset + BATCH_SIZE;
  const hasMore = nextOffset < total;

  // Last batch: refresh live stats for finished matches
  if (!hasMore) {
    const FINISHED = ['FT', 'AET', 'PEN'];
    const finishedFixtures = allFixtures.filter(f => FINISHED.includes(f.fixture?.status?.short));
    if (finishedFixtures.length > 0) {
      const liveStatsMap = {};
      await Promise.all(finishedFixtures.map(async (f) => {
        const fid = f.fixture.id;
        try {
          const stats = await fetchMatchStats(fid);
          if (stats) {
            await redisSet(KEYS.fixtureStats(fid), stats, TTL.yesterday);
            liveStatsMap[fid] = stats;
            await supabaseAdmin.from('match_analysis')
              .update({ live_stats: stats })
              .eq('fixture_id', fid)
              .catch(() => {});
          }
        } catch {}
      }));

      // Update live stats cache
      const existingLive = await redisGet(KEYS.liveStats(today)) || {};
      const updatedLive = { ...existingLive };
      for (const f of allFixtures) {
        const fid = f.fixture?.id;
        if (!fid) continue;
        const freshStats = liveStatsMap[fid];
        const cur = updatedLive[fid];
        if (freshStats) {
          updatedLive[fid] = { ...freshStats, status: f.fixture.status, goals: f.goals, score: f.score };
        } else if (cur) {
          updatedLive[fid] = { ...cur, status: f.fixture.status, goals: f.goals || cur.goals, score: f.score || cur.score };
        }
      }
      await redisSet(KEYS.liveStats(today), updatedLive, TTL.yesterday).catch(() => {});
    }
  }

  return Response.json({
    success: true,
    offset,
    nextOffset,
    hasMore,
    total,
    batchAnalyzed: analyzed,
    batchFailed: failed,
    totalAnalyzed: analyzedIds.length,
  });
}
