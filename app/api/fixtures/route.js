import { getFixtures, getQuota } from '../../../lib/api-football';
import { getAnalyzedMatchesFull } from '../../../lib/sanity-cache';
import { auth } from '@clerk/nextjs/server';
import { getSanityUserByClerkId } from '../../../lib/clerk-sync';
import { queryFromSanity, getFromSanity } from '../../../lib/sanity';
import { getCachedStandingsPositions } from '../../../lib/api-football';

export const dynamic = 'force-dynamic';

const API_HOST = 'v3.football.api-sports.io';
const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || new Date().toISOString().split('T')[0];

  try {
    let fixtures = [];
    let fromCache = false;
    let stale = false;
    let error = null;

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

    // For any match whose kickoff has passed and is NOT confirmed finished in Sanity,
    // fetch real status directly from API-Football — never trust Sanity for in-progress data
    const LIVE_STATUSES = ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'];
    let initialLiveStats = {};

    if (fixtures.length > 0) {
      const now = Date.now();
      const needsLiveStatus = fixtures.some(f => {
        if (FINISHED_STATUSES.includes(f.fixture?.status?.short)) return false;
        const kickoff = new Date(f.fixture.date).getTime();
        return now >= kickoff; // kickoff has passed
      });

      if (needsLiveStatus) {
        try {
          const key = process.env.FOOTBALL_API_KEY;
          if (key) {
            const res = await fetch(`https://${API_HOST}/fixtures?date=${date}`, {
              headers: { 'x-apisports-key': key },
              cache: 'no-store',
            });
            if (res.ok) {
              const data = await res.json();
              const apiFixtures = data.response || [];
              // Build lookup of fresh statuses from API-Football
              const freshMap = {};
              apiFixtures.forEach(af => { freshMap[af.fixture.id] = af; });

              // Identify which fixtures are currently live (for events/stats fetch)
              const liveFixtureIds = [];

              fixtures = fixtures.map(f => {
                // Already finished in cache — trust Sanity
                if (FINISHED_STATUSES.includes(f.fixture?.status?.short)) return f;
                // Kickoff hasn't passed — keep NS from cache
                const kickoff = new Date(f.fixture.date).getTime();
                if (now < kickoff) return f;
                // Kickoff passed, not finished: use API-Football fresh data
                const fresh = freshMap[f.fixture.id];
                if (fresh) {
                  if (LIVE_STATUSES.includes(fresh.fixture.status.short)) {
                    liveFixtureIds.push(f.fixture.id);
                  }
                  return {
                    ...f,
                    fixture: { ...f.fixture, status: fresh.fixture.status },
                    goals: fresh.goals || f.goals,
                    score: fresh.score || f.score,
                  };
                }
                return f;
              });

              // Fetch events + statistics for all live matches in parallel
              if (liveFixtureIds.length > 0) {
                const headers = { 'x-apisports-key': key };
                const fetchOpts = { headers, cache: 'no-store' };

                const detailResults = await Promise.allSettled(
                  liveFixtureIds.map(async (fid) => {
                    const [evRes, stRes] = await Promise.all([
                      fetch(`https://${API_HOST}/fixtures/events?fixture=${fid}`, fetchOpts),
                      fetch(`https://${API_HOST}/fixtures/statistics?fixture=${fid}`, fetchOpts),
                    ]);
                    const evData = evRes.ok ? await evRes.json() : null;
                    const stData = stRes.ok ? await stRes.json() : null;
                    const events = evData?.response || [];
                    const stats = stData?.response || [];

                    const fresh = freshMap[fid];
                    const homeId = fresh?.teams?.home?.id;
                    const awayId = fresh?.teams?.away?.id;

                    // Extract corners/cards from statistics
                    const getStatVal = (teamStats, type) => {
                      const stat = (teamStats?.statistics || []).find(s => s.type === type);
                      return stat?.value || 0;
                    };
                    const homeStats = stats.find(s => s.team?.id === homeId);
                    const awayStats = stats.find(s => s.team?.id === awayId);

                    const goalScorers = [];
                    const cardEvents = [];
                    const missedPenalties = [];
                    for (const ev of events) {
                      if (ev.type === 'Goal') {
                        if (ev.detail === 'Missed Penalty') {
                          missedPenalties.push({
                            player: ev.player?.name, teamId: ev.team?.id, teamName: ev.team?.name,
                            minute: ev.time?.elapsed, extra: ev.time?.extra,
                          });
                        } else {
                          goalScorers.push({
                            player: ev.player?.name, teamId: ev.team?.id, teamName: ev.team?.name,
                            minute: ev.time?.elapsed, extra: ev.time?.extra, type: ev.detail,
                          });
                        }
                      }
                      if (ev.type === 'Card') {
                        cardEvents.push({
                          player: ev.player?.name, teamId: ev.team?.id, teamName: ev.team?.name,
                          minute: ev.time?.elapsed, type: ev.detail,
                        });
                      }
                    }

                    return {
                      fixtureId: fid,
                      status: fresh?.fixture?.status,
                      goals: fresh?.goals,
                      corners: {
                        home: getStatVal(homeStats, 'Corner Kicks'),
                        away: getStatVal(awayStats, 'Corner Kicks'),
                        total: getStatVal(homeStats, 'Corner Kicks') + getStatVal(awayStats, 'Corner Kicks'),
                      },
                      yellowCards: {
                        home: getStatVal(homeStats, 'Yellow Cards'),
                        away: getStatVal(awayStats, 'Yellow Cards'),
                        total: getStatVal(homeStats, 'Yellow Cards') + getStatVal(awayStats, 'Yellow Cards'),
                      },
                      redCards: {
                        home: getStatVal(homeStats, 'Red Cards'),
                        away: getStatVal(awayStats, 'Red Cards'),
                        total: getStatVal(homeStats, 'Red Cards') + getStatVal(awayStats, 'Red Cards'),
                      },
                      goalScorers,
                      cardEvents,
                      missedPenalties,
                    };
                  })
                );

                for (const result of detailResults) {
                  if (result.status === 'fulfilled' && result.value) {
                    initialLiveStats[result.value.fixtureId] = result.value;
                  }
                }
              }
            }
          }
        } catch (e) {
          console.error('[FIXTURES] Live status fetch failed:', e.message);
          // Continue with cached data — Pusher will update the client
        }
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
