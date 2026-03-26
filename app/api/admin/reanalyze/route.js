import { auth, currentUser } from '@clerk/nextjs/server';
import { analyzeMatch, getFixtures } from '../../../../lib/api-football';
import { getCachedFixturesRaw, getCachedAnalysis, getAnalyzedFixtureIds, cacheFixtures } from '../../../../lib/sanity-cache';
import { deleteFromSanity, queryFromSanity } from '../../../../lib/sanity';
import { redisGet, redisDel, redisSet, KEYS } from '../../../../lib/redis';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const OWNER_EMAIL = 'ferneyolicas@gmail.com';

export async function POST(request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress?.toLowerCase();
  if (email !== OWNER_EMAIL) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const today = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const force = searchParams.get('force') === 'true';

  // force=true: delete ALL existing analysis + batch state for the date before re-running
  if (force) {
    const [existingIds, allAnalysisDocs] = await Promise.all([
      getAnalyzedFixtureIds(today),
      queryFromSanity(
        `*[_type == "footballMatchAnalysis" && date == $date]{ fixtureId }`,
        { date: today }
      ),
    ]);

    const allIds = [...new Set([
      ...existingIds,
      ...(allAnalysisDocs || []).map(d => d.fixtureId).filter(Boolean),
    ])];

    await Promise.all([
      ...allIds.map(id => deleteFromSanity('footballMatchAnalysis', String(id))),
      deleteFromSanity('appConfig', `analyzed-${today}`),
      deleteFromSanity('appConfig', `dailyBatch-${today}`),
      deleteFromSanity('appConfig', `dailyReport-${today}`),
      deleteFromSanity('footballFixturesCache', today),  // Delete stale fixtures cache too
      redisDel(`analysis:${today}`),
      redisDel(KEYS.fixtures(today)),
    ]);
  }

  // STEP 1: Fetch FRESH fixtures from API-Football (bypass ALL caches).
  // This gets real final scores, correct statuses (FT, AET, PEN).
  let fixtures = null;
  try {
    const result = await getFixtures(today, { forceApi: true });
    fixtures = result.fixtures || [];
  } catch {}

  // Fallback: Sanity cache, then Redis
  if (!fixtures || fixtures.length === 0) {
    fixtures = await getCachedFixturesRaw(today);
  }
  if (!fixtures || fixtures.length === 0) {
    const redisFixtures = await redisGet(KEYS.fixtures(today));
    if (Array.isArray(redisFixtures) && redisFixtures.length > 0) {
      fixtures = redisFixtures;
    }
  }

  if (!fixtures || fixtures.length === 0) {
    return Response.json({ success: true, analyzed: 0, message: 'No fixtures for this date' });
  }

  // Save fresh fixtures to Redis immediately so dashboard picks them up
  await redisSet(KEYS.fixtures(today), fixtures, 48 * 3600).catch(() => {});

  // Stream progress via SSE
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      let analyzed = 0;
      let skipped = 0;
      let failed = 0;
      const total = fixtures.length;

      // Collect results to build Redis cache at the end (bypasses Sanity CDN)
      const analyzedIds = [];
      const analyzedOdds = {};
      const analyzedData = {};

      send({ type: 'start', total });

      for (let i = 0; i < fixtures.length; i += 5) {
        const batch = fixtures.slice(i, i + 5);
        await Promise.all(
          batch.map(async (fixture) => {
            const fid = fixture.fixture?.id;
            const name = `${fixture.teams?.home?.name || '?'} vs ${fixture.teams?.away?.name || '?'}`;
            try {
              if (!force) {
                const existing = await getCachedAnalysis(fid, today);
                if (existing) {
                  skipped++;
                  // Still collect for Redis cache
                  analyzedIds.push(fid);
                  if (existing.odds?.matchWinner) analyzedOdds[fid] = existing.odds.matchWinner;
                  analyzedData[fid] = buildSummary(existing);
                  send({ type: 'progress', current: analyzed + skipped + failed, total, analyzed, skipped, failed, match: name });
                  return;
                }
              }
              const result = await analyzeMatch(fixture, { date: today, force });
              analyzed++;
              // Collect fresh analysis for Redis cache
              if (result.analysis) {
                const a = result.analysis;
                analyzedIds.push(fid);
                if (a.odds?.matchWinner) analyzedOdds[fid] = a.odds.matchWinner;
                analyzedData[fid] = buildSummary(a);
              }
            } catch (e) {
              failed++;
              console.error(`[REANALYZE] Failed ${fid}:`, e.message);
            }
            send({
              type: 'progress',
              current: analyzed + skipped + failed,
              total,
              analyzed,
              skipped,
              failed,
              match: name,
            });
          })
        );
      }

      // Save analysis results DIRECTLY to Redis — bypasses Sanity CDN completely.
      // The dashboard reads from this cache first, so it gets fresh data immediately.
      const analysisCache = {
        globallyAnalyzed: analyzedIds,
        analyzedOdds,
        analyzedData,
      };
      await redisSet(`analysis:${today}`, analysisCache, 12 * 3600).catch(() => {});

      send({ type: 'done', analyzed, skipped, failed, total });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

// Build the summary object that getAnalyzedMatchesFull returns for each match
function buildSummary(a) {
  return {
    fixtureId: a.fixtureId, homeTeam: a.homeTeam, awayTeam: a.awayTeam,
    homeLogo: a.homeLogo, awayLogo: a.awayLogo, homeId: a.homeId, awayId: a.awayId,
    league: a.league, leagueId: a.leagueId, leagueLogo: a.leagueLogo,
    kickoff: a.kickoff, status: a.status, goals: a.goals, odds: a.odds,
    combinada: a.combinada, calculatedProbabilities: a.calculatedProbabilities,
    homePosition: a.homePosition, awayPosition: a.awayPosition,
  };
}
