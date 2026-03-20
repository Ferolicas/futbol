import { getFixtures, getQuota } from '../../../lib/api-football';
import { getAnalyzedMatchesFull } from '../../../lib/sanity-cache';
import { auth } from '@clerk/nextjs/server';
import { getSanityUserByClerkId } from '../../../lib/clerk-sync';
import { queryFromSanity, getFromSanity } from '../../../lib/sanity';
import { getCachedStandingsPositions } from '../../../lib/api-football';
import { redisGet, KEYS } from '../../../lib/redis';

export const dynamic = 'force-dynamic';

const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || new Date().toISOString().split('T')[0];

  try {
    let fixtures = [];
    let fromCache = false;
    let stale = false;
    let error = null;

    // 1. Try Redis first (instant)
    const redisFixtures = await redisGet(KEYS.fixtures(date));
    if (redisFixtures && Array.isArray(redisFixtures) && redisFixtures.length > 0) {
      fixtures = redisFixtures;
      fromCache = true;
    } else {
      // 2. Fallback to Sanity/API-Football
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

    // Read live stats from Redis (populated by cron/live every minute)
    // No API-Football calls from this endpoint — all live data comes from Redis/Pusher
    let initialLiveStats = {};

    if (fixtures.length > 0) {
      const liveData = await redisGet(KEYS.liveStats(date));
      if (liveData && typeof liveData === 'object') {
        initialLiveStats = liveData;
        // Apply live status updates to fixtures
        fixtures = fixtures.map(f => {
          const live = liveData[f.fixture.id];
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
    }

    // Auto-trigger daily batch if first visit of the day (using client's date)
    if (fixtures.length > 0) {
      const batchFlag = await getFromSanity('appConfig', `dailyBatch-${date}`);
      if (!batchFlag?.started) {
        // First visit of the day — trigger full analysis batch in background
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || (process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : 'http://localhost:3000');

        fetch(`${baseUrl}/api/cron/daily?date=${date}`, {
          headers: { 'x-internal-trigger': 'true' },
        }).catch(() => {}); // Fire and forget
      }
    }

    // Get user-specific data
    let hidden = [];
    let analyzed = [];
    const { userId: clerkId } = await auth();
    const sanityUser = clerkId ? await getSanityUserByClerkId(clerkId) : null;
    const userId = sanityUser?._id;

    let userRemovedAnalyzed = [];
    if (userId) {
      const [hiddenDoc, removedDoc] = await Promise.all([
        queryFromSanity(
          `*[_type == "cfaUserData" && userId == $userId && dataType == "hidden"][0]`,
          { userId }
        ),
        queryFromSanity(
          `*[_type == "cfaUserData" && userId == $userId && dataType == "removedAnalyzed" && date == $date][0]`,
          { userId, date }
        ),
      ]);
      hidden = hiddenDoc?.fixtureIds || [];
      userRemovedAnalyzed = removedDoc?.fixtureIds || [];
    }

    // Get globally analyzed matches (from daily batch)
    const fixtureIds = fixtures.map(f => f.fixture.id);
    let globallyAnalyzed = [];

    if (fixtureIds.length > 0) {
      const analyzedDocs = await queryFromSanity(
        `*[_type == "footballMatchAnalysis" && fixtureId in $ids]{ fixtureId }`,
        { ids: fixtureIds }
      );
      globallyAnalyzed = (analyzedDocs || []).map(d => d.fixtureId);
    }

    // Filter out matches the user has personally removed from their analyzed tab
    const userAnalyzed = globallyAnalyzed.filter(id => !userRemovedAnalyzed.includes(id));

    // Only fetch full data for analyzed matches
    const { analyzedOdds, analyzedData } = globallyAnalyzed.length > 0
      ? await getAnalyzedMatchesFull(globallyAnalyzed)
      : { analyzedOdds: {}, analyzedData: {} };

    // Merge The Odds API cached odds into analyzed data
    // This ensures real bookmaker odds appear even if API-Football odds were empty
    if (fixtureIds.length > 0) {
      try {
        const oddsDocs = await queryFromSanity(
          `*[_type == "oddsCache" && date == $date]{ fixtureId, odds }`,
          { date }
        );
        if (oddsDocs?.length > 0) {
          for (const doc of oddsDocs) {
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
                // No API-Football odds — use The Odds API entirely
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
        }
      } catch (e) {
        // Non-critical: odds enrichment failed, continue without
        console.error('[FIXTURES] Odds merge error:', e.message);
      }
    }

    const quota = await getQuota();

    // Get cached standings positions
    let standings = {};
    if (fixtures.length > 0) {
      const leagueIds = [...new Set(fixtures.map(f => f.league?.id).filter(Boolean))];
      try {
        standings = await getCachedStandingsPositions(leagueIds);
      } catch {}
    }

    // Batch status
    const batchFlag = await getFromSanity('appConfig', `dailyBatch-${date}`);

    return Response.json({
      fixtures,
      fromCache,
      stale,
      quota,
      hidden,
      analyzed: userAnalyzed,
      analyzedOdds,
      analyzedData,
      standings,
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
