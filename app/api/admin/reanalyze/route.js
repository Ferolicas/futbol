import { analyzeMatch, getFixtures, fetchMatchStats, resetRateLimiter } from '../../../../lib/api-football';
import { getCachedAnalysis } from '../../../../lib/sanity-cache';
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../../lib/supabase';
import { redisGet, redisDel, redisSet, KEYS, TTL } from '../../../../lib/redis';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const OWNER_EMAIL = 'ferneyolicas@gmail.com';
const BATCH_SIZE = 10;

const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']);
const LIVE_STATUSES    = new Set(['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE', 'INT']);

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
  const offset = parseInt(searchParams.get('offset') || '0', 10);

  let allFixtures = null;

  // First batch (offset=0): fetch/use cached fixtures — do NOT wipe existing analysis
  if (offset === 0) {
    // Try Redis first, avoid an API call if fixtures already cached today
    let cachedFixtures = await redisGet(KEYS.fixtures(today));

    if (!cachedFixtures || !Array.isArray(cachedFixtures) || cachedFixtures.length === 0) {
      // Not in Redis — fetch fresh from API
      resetRateLimiter();
      try {
        const result = await getFixtures(today, { forceApi: true });
        cachedFixtures = result.fixtures || [];
        if (cachedFixtures.length > 0) {
          await redisSet(KEYS.fixtures(today), cachedFixtures, 48 * 3600).catch(() => {});
        }
      } catch {}
    }

    if (!cachedFixtures || cachedFixtures.length === 0) {
      return Response.json({ success: true, analyzed: 0, total: 0, hasMore: false, message: 'No fixtures for this date' });
    }

    allFixtures = cachedFixtures;
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

  // Load accumulated analysis summary (built up across batches — preserved from cron runs)
  const existing = await redisGet(`analysis:${today}`) || { globallyAnalyzed: [], analyzedOdds: {}, analyzedData: {} };
  const analyzedIds    = existing.globallyAnalyzed || [];
  const analyzedOdds   = existing.analyzedOdds || {};
  const analyzedData   = existing.analyzedData || {};
  const analyzedIdSet  = new Set(analyzedIds);

  let analyzed = 0, skipped = 0, failed = 0;

  for (const fixture of batch) {
    const fid    = fixture.fixture?.id;
    const status = fixture.fixture?.status?.short;

    // Skip finished matches — apostamos antes del partido, no tiene sentido analizarlos ahora
    if (FINISHED_STATUSES.has(status)) {
      skipped++;
      continue;
    }

    // Skip live matches — el partido ya empezó, no se puede apostar
    if (LIVE_STATUSES.has(status)) {
      skipped++;
      continue;
    }

    // Skip already analyzed NS matches — they have a valid analysis in cache
    if (analyzedIdSet.has(fid)) {
      // Double-check the per-fixture cache is actually there and fresh
      const cached = await getCachedAnalysis(fid, today, { strict: true });
      if (cached) {
        skipped++;
        continue;
      }
      // Cache miss (expired or never saved) — fall through and re-analyze
    }

    // Only analyze NS / TBD / upcoming fixtures
    let result = null;
    let lastErr = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Do NOT pass force:true — analyzeMatch will check its own cache first
        result = await analyzeMatch(fixture, { date: today });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`[reanalyze] Attempt ${attempt + 1} failed for ${fid}: ${e.message}`);
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }

    if (result) {
      const a = result.analysis || result;
      if (!result.fromCache) analyzed++;
      else skipped++; // was already cached — counts as skipped
      analyzedIds.push(fid);
      analyzedIdSet.add(fid);
      if (a.odds?.matchWinner) analyzedOdds[fid] = a.odds.matchWinner;
      analyzedData[fid] = buildSummary(a);
    } else {
      failed++;
      console.error(`[reanalyze] All attempts failed for ${fid}:`, lastErr?.message);
    }
  }

  // Persist accumulated progress (safe even if later batches never arrive)
  await redisSet(`analysis:${today}`, { globallyAnalyzed: analyzedIds, analyzedOdds, analyzedData }, 12 * 3600).catch(() => {});

  const nextOffset = offset + BATCH_SIZE;
  const hasMore = nextOffset < total;

  // Last batch: update live stats for finished matches if needed
  if (!hasMore) {
    const finishedFixtures = allFixtures.filter(f => FINISHED_STATUSES.has(f.fixture?.status?.short));
    if (finishedFixtures.length > 0) {
      const liveStatsMap = {};
      await Promise.all(finishedFixtures.map(async (f) => {
        const fid = f.fixture.id;
        // Only fetch stats if not already in Redis
        const existing = await redisGet(KEYS.fixtureStats(fid));
        if (existing?.corners?.total > 0 || existing?.goalScorers?.length > 0) return;
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

      if (Object.keys(liveStatsMap).length > 0) {
        const existingLive = await redisGet(KEYS.liveStats(today)) || {};
        const updatedLive = { ...existingLive };
        for (const [fid, freshStats] of Object.entries(liveStatsMap)) {
          const f = allFixtures.find(x => x.fixture?.id === Number(fid));
          updatedLive[fid] = { ...freshStats, status: f?.fixture?.status, goals: f?.goals, score: f?.score };
        }
        await redisSet(KEYS.liveStats(today), updatedLive, TTL.yesterday).catch(() => {});
      }
    }

    // Mark daily batch as completed so Phase 4 doesn't re-trigger analysis
    await redisSet(`dailyBatch:${today}`, {
      completed: true,
      fixtureCount: total,
      completedAt: new Date().toISOString(),
      source: 'manual-reanalyze',
    }, 86400).catch(() => {});
  }

  return Response.json({
    success: true,
    offset,
    nextOffset,
    hasMore,
    total,
    batchAnalyzed: analyzed,
    batchSkipped: skipped,
    batchFailed: failed,
    totalAnalyzed: analyzedIds.length,
  });
}
