import { getFixtures, getQuota, getCachedStandingsPositions } from '../../../lib/api-football';
import { getAnalyzedMatchesFull, getCachedFixturesRaw } from '../../../lib/sanity-cache';
import { auth } from '@clerk/nextjs/server';
import { getSanityUserByClerkId } from '../../../lib/clerk-sync';
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
    const authPromise = auth();

    let fixtures = [];
    let fromCache = false;
    let stale = false;
    let error = null;

    // 1. Try Redis first (instant)
    const redisFixtures = await redisGet(KEYS.fixtures(date));
    if (redisFixtures && Array.isArray(redisFixtures) && redisFixtures.length > 0) {
      fixtures = redisFixtures;
      fromCache = true;
    } else if (isPastDate) {
      // 2. Past dates: use getCachedFixturesRaw (Sanity only, no API call -- past matches never change)
      const rawFixtures = await getCachedFixturesRaw(date);
      if (rawFixtures && rawFixtures.length > 0) {
        fixtures = rawFixtures;
        fromCache = true;
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
      { userId: clerkId },
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
      authPromise,
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

    // Auto-trigger live cron on page load — rate-limited to once every 45s via Redis lock.
    // Ensures stale matches (stuck at 90:xx) resolve within seconds of a user entering the platform,
    // instead of waiting up to 1 minute for the scheduled cron.
    if (date === todayStr) {
      const hasLiveMatches = Object.values(liveData || {}).some(m =>
        ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'].includes(m.status?.short)
      );
      if (hasLiveMatches) {
        const lock = await redisGet(KEYS.liveCronLock);
        if (!lock) {
          // Set lock for 45s before firing so concurrent requests don't all trigger
          await redisSet(KEYS.liveCronLock, '1', 45);
          fetch(`${baseUrl}/api/cron/live?secret=${process.env.CRON_SECRET}`, {
            headers: { 'x-internal-trigger': 'true' },
          }).catch(() => {}); // Fire and forget
        }
      }
    }

    // ===== PHASE 5: User data (auth resolved above) =====
    const sanityUserPromise = clerkId ? getSanityUserByClerkId(clerkId) : Promise.resolve(null);

    // While user lookup runs, resolve analysis + odds + standings from cache or Sanity in parallel
    const [sanityUser, analysisResult, oddsResult, standingsResult] = await Promise.all([
      sanityUserPromise,

      // Analysis: use Redis cache or fall back to Sanity
      (async () => {
        // For past dates: skip Redis cache and query Sanity origin directly
        // This prevents stale partial lists from hiding analyzed matches
        if (!isPastDate && cachedAnalysisData) return cachedAnalysisData;
        if (fixtureIds.length === 0) return { globallyAnalyzed: [], analyzedOdds: {}, analyzedData: {} };

        // Use origin client (not CDN) to guarantee fresh results
        const analyzedDocs = await queryFromSanityFresh(
          `*[_type == "footballMatchAnalysis" && fixtureId in $ids]{ fixtureId }`,
          { ids: fixtureIds }
        );
        const globallyAnalyzed = (analyzedDocs || []).map(d => d.fixtureId);

        const { analyzedOdds, analyzedData } = globallyAnalyzed.length > 0
          ? await getAnalyzedMatchesFull(globallyAnalyzed)
          : { analyzedOdds: {}, analyzedData: {} };

        const result = { globallyAnalyzed, analyzedOdds, analyzedData };
        // Cache in Redis for next request (only for today — past dates always query fresh)
        if (!isPastDate) {
          redisSet(analysisRedisKey, result, ANALYSIS_CACHE_TTL).catch(() => {});
        }
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

    const userId = sanityUser?._id;

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
