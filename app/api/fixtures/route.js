import { getFixtures, getQuota, getCachedStandingsPositions } from '../../../lib/api-football';
import { getAnalyzedMatchesFull, getCachedFixturesRaw } from '../../../lib/sanity-cache';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../../../lib/auth';
import { queryFromSanity, queryFromSanityFresh, getFromSanity } from '../../../lib/sanity';
import { redisGet, redisSet, redisDel, KEYS } from '../../../lib/redis';

const FT_STATS_FIELDS = ['corners', 'yellowCards', 'redCards', 'goalScorers', 'cardEvents', 'missedPenalties'];

export const dynamic = 'force-dynamic';

const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];

// Redis TTLs for new cache layers (seconds)
const ANALYSIS_CACHE_TTL = 4 * 3600;   // 4 hours
const ODDS_CACHE_TTL = 4 * 3600;       // 4 hours
const STANDINGS_CACHE_TTL = 12 * 3600;  // 12 hours

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || new Date().toISOString().split('T')[0];

  try {
    // ===== PHASE 1: Load fixtures (Redis -> Sanity/API) + start auth in parallel =====
    const todayStr = new Date().toISOString().split('T')[0];
    const isPastDate = date < todayStr;

    // Start auth early -- it runs in parallel with fixture loading
    const sessionPromise = getServerSession(authOptions);

    let fixtures = [];
    let fromCache = false;
    let stale = false;
    let error = null;

    // 1. Try Redis first (instant)
    const redisFixtures = await redisGet(KEYS.fixtures(date));
    if (redisFixtures && Array.isArray(redisFixtures) && redisFixtures.length > 0) {
      // For past dates, check if Redis has stale live/NS statuses that need refreshing
      const STALE_STATUSES = ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE', 'NS'];
      const redisHasStale = isPastDate && redisFixtures.some(f => STALE_STATUSES.includes(f.fixture?.status?.short));
      if (redisHasStale) {
        // Redis has stale data for a past date — force refresh from API
        try {
          const result = await getFixtures(date, { forceApi: true });
          fixtures = result.fixtures || redisFixtures;
          fromCache = false;
          // Overwrite Redis with fresh data
          redisSet(KEYS.fixtures(date), fixtures, 48 * 3600).catch(() => {});
        } catch {
          fixtures = redisFixtures;
          fromCache = true;
        }
      } else {
        fixtures = redisFixtures;
        fromCache = true;
      }
    } else if (isPastDate) {
      // 2. Past dates: load from Sanity cache first
      const rawFixtures = await getCachedFixturesRaw(date);
      if (rawFixtures && rawFixtures.length > 0) {
        // Check if any matches have stale live statuses (should be finished by now)
        const LIVE_STATUSES = ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE', 'NS'];
        const hasStale = rawFixtures.some(f => LIVE_STATUSES.includes(f.fixture?.status?.short));
        if (hasStale) {
          // Some matches still show live/NS — refresh from API to get final scores
          try {
            const result = await getFixtures(date, { forceApi: true });
            fixtures = result.fixtures || rawFixtures;
            fromCache = false;
            // Save fresh fixtures to Redis so next request is instant
            if (fixtures !== rawFixtures) {
              redisSet(KEYS.fixtures(date), fixtures, 48 * 3600).catch(() => {});
            }
          } catch {
            fixtures = rawFixtures; // API failed — use cache as-is
            fromCache = true;
          }
        } else {
          fixtures = rawFixtures;
          fromCache = true;
        }
      }
    } else {
      // 3. Current/future dates: fallback to Sanity/API-Football
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

    // ===== PHASE 2: Parallel middle section =====
    // Now that we have fixtures, run ALL dependent lookups in parallel

    const fixtureIds = fixtures.map(f => f.fixture.id);
    const leagueIds = fixtures.length > 0
      ? [...new Set(fixtures.map(f => f.league?.id).filter(Boolean))]
      : [];

    // Build Redis keys for new cache layers
    const analysisRedisKey = `analysis:${date}`;
    const oddsRedisKey = `odds:${date}`;
    const standingsRedisKey = `standings:positions`;

    // Launch all parallel lookups at once
    const [
      liveData,
      batchFlag,
      session,
      cachedAnalysisData,
      cachedOddsData,
      cachedStandings,
      quota,
    ] = await Promise.all([
      // 1. Live stats from Redis
      fixtures.length > 0 ? redisGet(KEYS.liveStats(date)) : null,
      // 2. Batch flag from Sanity (read ONCE, reused below)
      fixtures.length > 0 ? getFromSanity('appConfig', `dailyBatch-${date}`) : null,
      // 3. Auth (already started, just await)
      sessionPromise,
      // 4. Analysis data: Redis first, then null (Sanity loaded below if needed)
      fixtureIds.length > 0 ? redisGet(analysisRedisKey) : null,
      // 5. Odds data: Redis first
      fixtureIds.length > 0 ? redisGet(oddsRedisKey) : null,
      // 6. Standings: Redis first
      fixtures.length > 0 ? redisGet(standingsRedisKey) : null,
      // 7. Quota
      getQuota(),
    ]);

    // ===== PHASE 3: Process live stats =====
    let initialLiveStats = {};

    if (fixtures.length > 0) {
      if (liveData && typeof liveData === 'object') {
        initialLiveStats = liveData;

        // For fixtures with a live status in live:{date}, check stats:{fid} to detect
        // matches that already finished (stale detection saves FT status there)
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
              // Match is actually finished — update live:{date} entry so fixture renders as FT
              initialLiveStats[fid] = stats;
            }
          }));
        }

        // Apply live/FT status updates to fixtures
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
      }

      // For finished matches without stats (or with all-zero stats) in live:{date},
      // load from Redis stats:{fid} (written by stale-detection with real /fixtures?id={fid} data)
      const ftWithoutStats = fixtures.filter(f => {
        if (!FINISHED_STATUSES.includes(f.fixture?.status?.short)) return false;
        const s = initialLiveStats[f.fixture.id];
        if (!s) return true;
        // Also reload if stats are all zeros — live=all doesn't include statistics,
        // but stale-detection saves real stats to stats:{fid} after the match ends
        const hasRealStats =
          (s.corners?.total > 0) ||
          (s.yellowCards?.total > 0) ||
          (s.redCards?.home > 0 || s.redCards?.away > 0) ||
          (s.cardEvents?.length > 0);
        return !hasRealStats;
      });

      if (ftWithoutStats.length > 0) {
        await Promise.all(ftWithoutStats.map(async (f) => {
          const fid = f.fixture.id;
          // Try Redis first (stats:{fid} has 48h TTL)
          let stats = await redisGet(KEYS.fixtureStats(fid));
          // Fallback to Sanity (permanent storage)
          if (!stats) {
            stats = await getFromSanity('liveMatchStats', String(fid));
          }
          if (stats && FT_STATS_FIELDS.some(k => stats[k])) {
            initialLiveStats[fid] = stats;
          }
        }));
      }
    }

    // ===== PHASE 4: Auto-trigger daily batch (uses batchFlag already loaded) =====
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000');

    if (fixtures.length > 0 && !batchFlag?.started) {
      fetch(`${baseUrl}/api/cron/daily?date=${date}`, {
        headers: { 'x-internal-trigger': 'true' },
      }).catch(() => {}); // Fire and forget
    }

    // Live cron auto-trigger moved to /api/refresh-live (called by dashboard on mount + reload button).
    // That endpoint triggers BOTH live + corners crons with its own 15s rate limit.

    // ===== PHASE 5: User data (auth resolved above) =====
    // While resolving analysis + odds + standings from cache or Sanity in parallel
    const [analysisResult, oddsResult, standingsResult] = await Promise.all([

      // Analysis: use Redis cache or fall back to Sanity
      (async () => {
        // Redis cache exists — use it (reanalyze saves directly to Redis, bypassing CDN)
        if (cachedAnalysisData) return cachedAnalysisData;
        if (fixtureIds.length === 0) return { globallyAnalyzed: [], analyzedOdds: {}, analyzedData: {} };

        // Use origin client (not CDN) to guarantee fresh results
        const analyzedDocs = await queryFromSanityFresh(
          `*[_type == "footballMatchAnalysis" && fixtureId in $ids]{ fixtureId }`,
          { ids: fixtureIds }
        );
        const globallyAnalyzed = (analyzedDocs || []).map(d => d.fixtureId);

        // For past dates, read from Sanity origin (CDN may be stale after re-analyze)
        const { analyzedOdds, analyzedData } = globallyAnalyzed.length > 0
          ? await getAnalyzedMatchesFull(globallyAnalyzed, { fresh: isPastDate })
          : { analyzedOdds: {}, analyzedData: {} };

        const result = { globallyAnalyzed, analyzedOdds, analyzedData };
        // Cache in Redis for next request
        redisSet(analysisRedisKey, result, ANALYSIS_CACHE_TTL).catch(() => {});
        return result;
      })(),

      // Odds: use Redis cache or fall back to Sanity
      (async () => {
        if (cachedOddsData) return cachedOddsData;
        if (fixtureIds.length === 0) return [];

        const oddsDocs = await queryFromSanity(
          `*[_type == "oddsCache" && date == $date]{ fixtureId, odds }`,
          { date }
        );
        const result = oddsDocs || [];
        // Cache in Redis for next request
        if (result.length > 0) {
          redisSet(oddsRedisKey, result, ODDS_CACHE_TTL).catch(() => {});
        }
        return result;
      })(),

      // Standings: use Redis cache or fall back to Sanity
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
        } catch {
          return {};
        }
      })(),
    ]);

    const userId = session?.user?.id || null;

    // ===== PHASE 6: User-specific data =====
    let hidden = [];
    let userRemovedAnalyzed = [];
    if (userId) {
      const [hiddenFromRedis, removedDoc] = await Promise.all([
        // Read hidden list from Redis first — avoids Sanity CDN staleness after a write
        redisGet(KEYS.userHidden(userId)),
        queryFromSanity(
          `*[_type == "cfaUserData" && userId == $userId && dataType == "removedAnalyzed" && date == $date][0]`,
          { userId, date }
        ),
      ]);

      if (Array.isArray(hiddenFromRedis)) {
        hidden = hiddenFromRedis;
      } else {
        // Redis miss — use origin client (no CDN) to guarantee fresh data
        const hiddenDoc = await queryFromSanityFresh(
          `*[_type == "cfaUserData" && userId == $userId && dataType == "hidden"][0]`,
          { userId }
        );
        hidden = hiddenDoc?.fixtureIds || [];
        if (hidden.length > 0) {
          redisSet(KEYS.userHidden(userId), hidden, 30 * 24 * 3600).catch(() => {});
        }
      }
      userRemovedAnalyzed = removedDoc?.fixtureIds || [];
    }

    // ===== PHASE 7: Merge analysis + odds =====
    const { globallyAnalyzed, analyzedOdds, analyzedData } = analysisResult;
    const userAnalyzed = (globallyAnalyzed || []).filter(id => !userRemovedAnalyzed.includes(id));

    // Merge The Odds API cached odds into analyzed data
    if (oddsResult && oddsResult.length > 0) {
      try {
        for (const doc of oddsResult) {
          const fid = doc.fixtureId;
          if (!fid || !doc.odds) continue;

          // Merge into analyzedOdds (matchWinner for card display)
          if (doc.odds.matchWinner) {
            if (!analyzedOdds[fid]) {
              analyzedOdds[fid] = doc.odds.matchWinner;
            }
          }

          // Merge into analyzedData odds (for accordion markets)
          if (analyzedData[fid]) {
            const existing = analyzedData[fid].odds;
            if (!existing || !existing.matchWinner) {
              // No API-Football odds -- use The Odds API entirely
              analyzedData[fid].odds = {
                ...(existing || {}),
                ...doc.odds,
              };
            } else {
              // Merge: fill missing markets from The Odds API
              if (!existing.matchWinner && doc.odds.matchWinner) {
                existing.matchWinner = doc.odds.matchWinner;
              }
              if (!existing.overUnder && doc.odds.overUnder) {
                existing.overUnder = doc.odds.overUnder;
              }
              // Add The Odds API bookmakers to allBookmakerOdds
              if (doc.odds.allBookmakerOdds?.length) {
                const names = new Set(
                  (existing.allBookmakerOdds || []).map(b => b.name?.toLowerCase())
                );
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
        // Non-critical: odds enrichment failed, continue without
        console.error('[FIXTURES] Odds merge error:', e.message);
      }
    }

    return Response.json({
      fixtures,
      fromCache,
      stale,
      quota,
      hidden,
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
