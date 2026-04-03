import { getFixtures, getQuota, getCachedStandingsPositions } from '../../../lib/api-football';
import { getAnalyzedMatchesFull, getAnalyzedFixtureIds } from '../../../lib/sanity-cache';
import { redisGet, redisSet, KEYS } from '../../../lib/redis';
import { createSupabaseServerClient } from '../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../lib/supabase';
import { filterFixturesByLocalDate } from '../../../lib/timezone';

const FT_STATS_FIELDS = ['corners', 'yellowCards', 'redCards', 'goalScorers', 'cardEvents', 'missedPenalties'];

export const dynamic = 'force-dynamic';

const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];

// Redis TTLs for cache layers (seconds)
const ANALYSIS_CACHE_TTL = 4 * 3600;   // 4 hours
const ODDS_CACHE_TTL = 4 * 3600;       // 4 hours
const STANDINGS_CACHE_TTL = 12 * 3600; // 12 hours

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const userTimezone = searchParams.get('tz') || 'UTC';
  const todayStr = new Date().toISOString().split('T')[0];
  const date = searchParams.get('date') || todayStr;

  try {
    // ===== PHASE 1: Load fixtures (Redis -> Supabase/API) + start auth in parallel =====
    const isPastDate = date < todayStr;

    // Start Supabase auth early — runs in parallel with fixture loading
    const supabase = createSupabaseServerClient();
    const sessionPromise = supabase.auth.getUser();

    let fixtures = [];
    let fromCache = false;
    let stale = false;
    let error = null;

    // 1. Try Redis first (instant)
    const redisFixtures = await redisGet(KEYS.fixtures(date));
    if (redisFixtures && Array.isArray(redisFixtures) && redisFixtures.length > 0) {
      const STALE_STATUSES = ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE', 'NS'];
      const redisHasStale = isPastDate && redisFixtures.some(f => STALE_STATUSES.includes(f.fixture?.status?.short));
      if (redisHasStale) {
        try {
          const result = await getFixtures(date, { forceApi: true });
          fixtures = result.fixtures || redisFixtures;
          fromCache = false;
          redisSet(KEYS.fixtures(date), fixtures, 48 * 3600).catch(() => {});
        } catch (err) {
          console.error('[fixtures] API fetch failed for past date:', err.message);
          fixtures = redisFixtures;
          fromCache = true;
        }
      } else {
        fixtures = redisFixtures;
        fromCache = true;
      }
    } else if (isPastDate) {
      // 2. Past dates: load from Supabase fixtures_cache
      let cached = null;
      try {
        const result = await supabaseAdmin
          .from('fixtures_cache')
          .select('fixtures')
          .eq('date', date)
          .single();
        cached = result.data;
      } catch {}
      const rawFixtures = cached?.fixtures || null;
      if (rawFixtures && rawFixtures.length > 0) {
        const LIVE_STATUSES = ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE', 'NS'];
        const hasStale = rawFixtures.some(f => LIVE_STATUSES.includes(f.fixture?.status?.short));
        if (hasStale) {
          try {
            const result = await getFixtures(date, { forceApi: true });
            fixtures = result.fixtures || rawFixtures;
            fromCache = false;
            if (fixtures !== rawFixtures) {
              redisSet(KEYS.fixtures(date), fixtures, 48 * 3600).catch(() => {});
            }
          } catch (err) {
            console.error('[fixtures] past date API fetch failed:', err.message);
            fixtures = rawFixtures;
            fromCache = true;
          }
        } else {
          fixtures = rawFixtures;
          fromCache = true;
        }
      }
    } else {
      // 3. Current/future dates: fetch from API-Football
      try {
        const result = await getFixtures(date);
        fixtures = result.fixtures || [];
        fromCache = result.fromCache || false;
        stale = result.stale || false;
      } catch (e) {
        error = e.message === 'RATE_LIMIT'
          ? 'Limite de llamadas alcanzado. Usando datos en cache.'
          : e.message;
      }
    }

    // For non-UTC timezones, a local day spans 2 UTC days.
    // e.g., Madrid April 4 (00:00-23:59) = UTC April 3 22:00 → UTC April 4 21:59
    // Fetch adjacent day(s) from Redis/Supabase to catch cross-midnight matches.
    if (userTimezone !== 'UTC') {
      const d = new Date(date + 'T12:00:00Z');
      const prevDay = new Date(d.getTime() - 86400000).toISOString().split('T')[0];
      const nextDay = new Date(d.getTime() + 86400000).toISOString().split('T')[0];
      const adjacentDates = [prevDay, nextDay].filter(ad => ad !== date);
      const existingIds = new Set(fixtures.map(f => f.fixture?.id));

      await Promise.all(adjacentDates.map(async (ad) => {
        // L1: Redis
        let adjFixtures = await redisGet(KEYS.fixtures(ad));
        // L2: Supabase fixtures_cache
        if (!adjFixtures || !Array.isArray(adjFixtures) || adjFixtures.length === 0) {
          try {
            const { data: row } = await supabaseAdmin
              .from('fixtures_cache')
              .select('fixtures')
              .eq('date', ad)
              .single();
            if (row?.fixtures) adjFixtures = row.fixtures;
          } catch {}
        }
        if (Array.isArray(adjFixtures)) {
          for (const f of adjFixtures) {
            if (f.fixture?.id && !existingIds.has(f.fixture.id)) {
              fixtures.push(f);
              existingIds.add(f.fixture.id);
            }
          }
        }
      }));

      // Now filter to only fixtures whose kickoff is on the requested LOCAL date
      fixtures = filterFixturesByLocalDate(fixtures, date, userTimezone);
    }

    // ===== PHASE 2: Parallel middle section =====
    const fixtureIds = fixtures.map(f => f.fixture.id);
    const leagueIds = fixtures.length > 0
      ? [...new Set(fixtures.map(f => f.league?.id).filter(Boolean))]
      : [];

    const analysisRedisKey = `analysis:${date}`;
    const oddsRedisKey = `odds:${date}`;
    const standingsRedisKey = `standings:positions`;

    // Live stats key: try client date first, also try UTC date if they differ
    // (cron writes with UTC date; client sends local date which can differ 00:00-02:00 local)
    const liveStatsKeys = [KEYS.liveStats(date)];
    if (date !== todayStr) liveStatsKeys.push(KEYS.liveStats(todayStr));

    const [
      liveDataResults,
      batchFlag,
      session,
      cachedAnalysisData,
      cachedOddsData,
      cachedStandings,
      quota,
    ] = await Promise.all([
      fixtures.length > 0 ? Promise.all(liveStatsKeys.map(k => redisGet(k))) : [],
      fixtures.length > 0 ? redisGet(`dailyBatch:${date}`) : null,
      sessionPromise.then(r => r.data?.user || null).catch(() => null),
      fixtureIds.length > 0 ? redisGet(analysisRedisKey) : null,
      fixtureIds.length > 0 ? redisGet(oddsRedisKey) : null,
      fixtures.length > 0 ? redisGet(standingsRedisKey) : null,
      getQuota(),
    ]);

    // Merge live data from both date keys (UTC date first, local date overwrites)
    let liveData = null;
    for (const ld of (liveDataResults || []).reverse()) {
      if (ld && typeof ld === 'object' && Object.keys(ld).length > 0) {
        liveData = liveData ? { ...liveData, ...ld } : ld;
      }
    }

    // ===== PHASE 3: Process live stats =====
    let initialLiveStats = {};

    if (fixtures.length > 0) {
      if (liveData && typeof liveData === 'object') {
        initialLiveStats = liveData;

        const liveInCache = fixtures.filter(f => {
          const live = liveData[f.fixture.id];
          return live && !FINISHED_STATUSES.includes(live.status?.short) &&
            !FINISHED_STATUSES.includes(f.fixture?.status?.short);
        });
        if (liveInCache.length > 0) {
          await Promise.all(liveInCache.map(async (f) => {
            const fid = f.fixture.id;
            const stats = await redisGet(KEYS.fixtureStats(fid));
            if (stats && FINISHED_STATUSES.includes(stats.status?.short)) {
              initialLiveStats[fid] = stats;
            }
          }));
        }
      }

      // Fix stale live stats: if fixture is FT but live entry still shows live status,
      // correct the status so the card doesn't stay stuck as "in play"
      const LIVE_STATUS_SET = new Set(['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE', 'INT']);
      for (const f of fixtures) {
        const fid = f.fixture.id;
        const live = initialLiveStats[fid];
        if (!live) continue;
        if (FINISHED_STATUSES.includes(f.fixture?.status?.short) &&
            LIVE_STATUS_SET.has(live.status?.short)) {
          initialLiveStats[fid] = {
            ...live,
            status: f.fixture.status,
            goals: f.goals || live.goals,
            score: f.score || live.score,
          };
        }
      }

      // Update fixture status/goals from live data
      fixtures = fixtures.map(f => {
        const live = initialLiveStats[f.fixture.id];
        if (!live) return f;
        if (FINISHED_STATUSES.includes(f.fixture?.status?.short)) return f;
        return {
          ...f,
          fixture: { ...f.fixture, status: live.status || f.fixture.status },
          goals: live.goals || f.goals,
          score: live.score || f.score,
        };
      });

      // For finished, live, or past-kickoff NS matches without stats, check Redis stats:{fid}
      const LIVE_STATUSES = ['1H', '2H', 'HT', 'ET', 'BT', 'P'];
      const now = Date.now();
      const needStats = fixtures.filter(f => {
        const status = f.fixture?.status?.short;
        const isLiveOrFinished = FINISHED_STATUSES.includes(status) || LIVE_STATUSES.includes(status);
        // Also check NS fixtures whose kickoff has passed (they may be live but fixtures cache is stale)
        const isPastKickoff = status === 'NS' && f.fixture?.date && new Date(f.fixture.date).getTime() < now - 5 * 60 * 1000;
        if (!isLiveOrFinished && !isPastKickoff) return false;
        const s = initialLiveStats[f.fixture.id];
        if (!s) return true;
        const hasRealStats =
          (s.corners?.total > 0) ||
          (s.yellowCards?.total > 0) ||
          (s.redCards?.home > 0 || s.redCards?.away > 0) ||
          (s.cardEvents?.length > 0) ||
          (s.goalScorers?.length > 0);
        return !hasRealStats;
      });

      if (needStats.length > 0) {
        await Promise.all(needStats.map(async (f) => {
          const fid = f.fixture.id;
          // L1: Redis
          let stats = await redisGet(KEYS.fixtureStats(fid));
          // L2: Supabase fallback (permanent storage)
          if (!stats || !FT_STATS_FIELDS.some(k => stats[k])) {
            try {
              const { data: row } = await supabaseAdmin
                .from('match_analysis')
                .select('live_stats')
                .eq('fixture_id', fid)
                .not('live_stats', 'is', null)
                .limit(1)
                .single();
              if (row?.live_stats && FT_STATS_FIELDS.some(k => row.live_stats[k])) {
                stats = row.live_stats;
                redisSet(KEYS.fixtureStats(fid), stats, TTL.yesterday).catch(() => {});
              }
            } catch {}
          }
          if (stats && FT_STATS_FIELDS.some(k => stats[k])) {
            // MERGE stats (corners/cards/scorers) into existing liveStats
            // but NEVER overwrite a more advanced status (FT > 2H > 1H > NS)
            const existing = initialLiveStats[fid];
            const existingIsFT = existing && FINISHED_STATUSES.includes(existing.status?.short);
            const fixtureIsFT = FINISHED_STATUSES.includes(f.fixture?.status?.short);

            if (existingIsFT || fixtureIsFT) {
              // Keep the FT status/goals/score, only take stats data (corners, cards, scorers)
              initialLiveStats[fid] = {
                ...(existing || {}),
                corners: stats.corners || existing?.corners,
                yellowCards: stats.yellowCards || existing?.yellowCards,
                redCards: stats.redCards || existing?.redCards,
                goalScorers: stats.goalScorers?.length > 0 ? stats.goalScorers : (existing?.goalScorers || []),
                cardEvents: stats.cardEvents?.length > 0 ? stats.cardEvents : (existing?.cardEvents || []),
                missedPenalties: stats.missedPenalties?.length > 0 ? stats.missedPenalties : (existing?.missedPenalties || []),
                // Preserve the correct final status
                status: existing?.status && FINISHED_STATUSES.includes(existing.status.short)
                  ? existing.status
                  : (FINISHED_STATUSES.includes(stats.status?.short) ? stats.status : f.fixture.status),
                goals: existing?.goals || stats.goals || f.goals,
                score: existing?.score || stats.score || f.score,
              };
            } else {
              // Non-finished: use stats as-is (live match getting live data)
              initialLiveStats[fid] = stats;
              // Update fixture status if stats is more recent
              if (stats.status) {
                const idx = fixtures.findIndex(x => x.fixture.id === fid);
                if (idx >= 0) {
                  const curElapsed = fixtures[idx].fixture.status.elapsed || 0;
                  const newElapsed = stats.status.elapsed || 0;
                  if (newElapsed > curElapsed || FINISHED_STATUSES.includes(stats.status.short)) {
                    fixtures[idx] = {
                      ...fixtures[idx],
                      fixture: { ...fixtures[idx].fixture, status: stats.status },
                      goals: stats.goals || fixtures[idx].goals,
                    };
                  }
                }
              }
            }
          }
        }));
      }
    }

    // ===== PHASE 4: Auto-trigger daily batch =====
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000');

    if (fixtures.length > 0 && !batchFlag?.started && !batchFlag?.completed) {
      fetch(`${baseUrl}/api/cron/daily?date=${date}`, {
        headers: { 'x-internal-trigger': 'true' },
      }).catch(() => {});
    }

    // ===== PHASE 5: User data (auth resolved above) =====
    const [analysisResult, oddsResult, standingsResult] = await Promise.all([

      // Analysis: use Redis cache or fall back to Supabase
      (async () => {
        if (cachedAnalysisData) return cachedAnalysisData;
        if (fixtureIds.length === 0) return { globallyAnalyzed: [], analyzedOdds: {}, analyzedData: {} };

        // Get analyzed fixture IDs — also check adjacent dates for cross-midnight fixtures
        const datesToCheck = [date];
        if (userTimezone !== 'UTC') {
          const d = new Date(date + 'T12:00:00Z');
          const prevDay = new Date(d.getTime() - 86400000).toISOString().split('T')[0];
          const nextDay = new Date(d.getTime() + 86400000).toISOString().split('T')[0];
          if (prevDay !== date) datesToCheck.push(prevDay);
          if (nextDay !== date) datesToCheck.push(nextDay);
        }
        const allIds = await Promise.all(datesToCheck.map(d => getAnalyzedFixtureIds(d)));
        // Merge and keep only IDs that are in the current fixture list
        const fixtureIdSet = new Set(fixtureIds);
        const globallyAnalyzed = [...new Set(allIds.flat())].filter(id => fixtureIdSet.has(id));

        const { analyzedOdds, analyzedData } = globallyAnalyzed.length > 0
          ? await getAnalyzedMatchesFull(globallyAnalyzed)
          : { analyzedOdds: {}, analyzedData: {} };

        const result = { globallyAnalyzed, analyzedOdds, analyzedData };
        redisSet(analysisRedisKey, result, ANALYSIS_CACHE_TTL).catch(() => {});
        return result;
      })(),

      // Odds: use Redis cache (populated by cron/odds)
      (async () => {
        if (cachedOddsData) return cachedOddsData;
        return [];
      })(),

      // Standings: use Redis cache or fetch fresh
      (async () => {
        if (cachedStandings && typeof cachedStandings === 'object' && Object.keys(cachedStandings).length > 0) {
          return cachedStandings;
        }
        if (leagueIds.length === 0) return {};
        try {
          const positions = await getCachedStandingsPositions(leagueIds);
          if (Object.keys(positions).length > 0) {
            redisSet(standingsRedisKey, positions, STANDINGS_CACHE_TTL).catch(() => {});
          }
          return positions;
        } catch (err) {
          console.error('[fixtures:standings] fetch failed:', err.message);
          return {};
        }
      })(),
    ]);

    const userId = session?.id || null;

    // ===== PHASE 6: User-specific data from Supabase =====
    let hidden = [];
    let favorites = [];
    if (userId) {
      const [hiddenRes, favRes] = await Promise.all([
        supabaseAdmin.from('user_hidden').select('fixture_id').eq('user_id', userId).eq('date', date),
        supabaseAdmin.from('user_favorites').select('fixture_id').eq('user_id', userId),
      ]);
      hidden = (hiddenRes.data || []).map(r => r.fixture_id);
      favorites = (favRes.data || []).map(r => r.fixture_id);
    }

    // ===== PHASE 7: Merge analysis + odds =====
    const { globallyAnalyzed, analyzedOdds, analyzedData } = analysisResult;
    const userAnalyzed = (globallyAnalyzed || []);

    if (oddsResult && oddsResult.length > 0) {
      try {
        for (const doc of oddsResult) {
          const fid = doc.fixtureId;
          if (!fid || !doc.odds) continue;

          if (doc.odds.matchWinner) {
            if (!analyzedOdds[fid]) {
              analyzedOdds[fid] = doc.odds.matchWinner;
            }
          }

          if (analyzedData[fid]) {
            const existing = analyzedData[fid].odds;
            if (!existing || !existing.matchWinner) {
              analyzedData[fid].odds = { ...(existing || {}), ...doc.odds };
            } else {
              if (!existing.matchWinner && doc.odds.matchWinner) existing.matchWinner = doc.odds.matchWinner;
              if (!existing.overUnder && doc.odds.overUnder) existing.overUnder = doc.odds.overUnder;
              if (doc.odds.allBookmakerOdds?.length) {
                const names = new Set((existing.allBookmakerOdds || []).map(b => b.name?.toLowerCase()));
                for (const bk of doc.odds.allBookmakerOdds) {
                  if (!names.has(bk.name?.toLowerCase())) {
                    if (!existing.allBookmakerOdds) existing.allBookmakerOdds = [];
                    existing.allBookmakerOdds.push(bk);
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        console.error('[fixtures] Odds merge error:', e.message);
      }
    }

    return Response.json({
      fixtures,
      fromCache,
      stale,
      quota,
      hidden,
      favorites,
      userTimezone,
      analyzed: userAnalyzed,
      analyzedOdds,
      analyzedData,
      standings: standingsResult,
      initialLiveStats,
      batchStatus: batchFlag ? {
        started: batchFlag.started || false,
        completed: batchFlag.completed || false,
        startedAt: batchFlag.startedAt || null,
      } : null,
      ...(error ? { error } : {}),
    }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (e) {
    const quota = await getQuota().catch(() => ({ used: 0, remaining: 100, limit: 100 }));
    return Response.json({
      error: e.message || 'Error loading fixtures',
      fixtures: [],
      quota,
      hidden: [],
      analyzed: [],
      analyzedOdds: {},
      analyzedData: {},
      standings: {},
    });
  }
}
