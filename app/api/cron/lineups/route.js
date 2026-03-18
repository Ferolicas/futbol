import { getFromSanity, saveToSanity } from '../../../../lib/sanity';
import { getCachedAnalysis, cacheAnalysis } from '../../../../lib/sanity-cache';
import { ALL_LEAGUE_IDS } from '../../../../lib/leagues';
import { computeAllProbabilities } from '../../../../lib/calculations';
import { buildCombinada } from '../../../../lib/combinada';
import { triggerEvent } from '../../../../lib/pusher';

// Smart Fetch: runs every 5 minutes
// Checks which matches are 45 min from kickoff, fetches lineups + injuries
// cron-job.org: GET /api/cron/lineups?secret=CRON_SECRET

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const API_HOST = 'v3.football.api-sports.io';

function getApiKey() {
  return process.env.FOOTBALL_API_KEY;
}

function verifyCronAuth(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret')
    || request.headers.get('authorization')?.replace('Bearer ', '');
  return secret === process.env.CRON_SECRET || process.env.NODE_ENV !== 'production';
}

async function fetchLineups(fixtureId) {
  const key = getApiKey();
  if (!key) return null;

  const res = await fetch(`https://${API_HOST}/fixtures/lineups?fixture=${fixtureId}`, {
    headers: { 'x-apisports-key': key },
    cache: 'no-store',
  });

  if (!res.ok) return null;
  const data = await res.json();
  return data.response || [];
}

async function fetchInjuries(fixtureId) {
  const key = getApiKey();
  if (!key) return null;

  const res = await fetch(`https://${API_HOST}/injuries?fixture=${fixtureId}`, {
    headers: { 'x-apisports-key': key },
    cache: 'no-store',
  });

  if (!res.ok) return null;
  const data = await res.json();
  return data.response || [];
}

export async function GET(request) {
  if (!verifyCronAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const now = Date.now();
    const WINDOW_MS = 45 * 60 * 1000;
    const TOLERANCE_MS = 5 * 60 * 1000;

    const cached = await getFromSanity('matchDay', today);
    if (!cached?.matches) {
      return Response.json({ success: true, message: 'No fixtures cached', updated: 0 });
    }

    // Find matches that are ~45 min from kickoff
    const matchesNearKickoff = cached.matches.filter(m => {
      if (m.fixture.status.short !== 'NS') return false;
      const kickoff = new Date(m.fixture.date).getTime();
      const timeUntil = kickoff - now;
      return timeUntil > 0 && timeUntil <= WINDOW_MS + TOLERANCE_MS && timeUntil >= WINDOW_MS - TOLERANCE_MS;
    });

    if (matchesNearKickoff.length === 0) {
      return Response.json({ success: true, message: 'No matches near kickoff', updated: 0 });
    }

    console.log(`[LINEUPS] ${matchesNearKickoff.length} matches ~45min from kickoff`);

    let updated = 0;
    let apiCalls = 0;
    const updatedFixtureIds = [];

    for (let i = 0; i < matchesNearKickoff.length; i += 5) {
      const batch = matchesNearKickoff.slice(i, i + 5);

      await Promise.all(batch.map(async (match) => {
        const fixtureId = match.fixture.id;

        try {
          const [lineups, injuries] = await Promise.all([
            fetchLineups(fixtureId),
            fetchInjuries(fixtureId),
          ]);
          apiCalls += 2;

          const existing = await getCachedAnalysis(fixtureId, today);

          if (existing) {
            const updatedAnalysis = {
              ...existing,
              lineups: lineups || existing.lineups,
              injuries: injuries || existing.injuries,
              lineupsUpdatedAt: new Date().toISOString(),
            };

            const probs = computeAllProbabilities(updatedAnalysis);
            updatedAnalysis.calculatedProbabilities = probs;
            updatedAnalysis.combinada = buildCombinada(probs, updatedAnalysis.odds, updatedAnalysis.playerHighlights);

            await cacheAnalysis(fixtureId, updatedAnalysis);
            updated++;
            updatedFixtureIds.push(fixtureId);
          } else {
            await saveToSanity('matchLineups', String(fixtureId), {
              fixtureId,
              lineups,
              injuries,
              fetchedAt: new Date().toISOString(),
            });
            updated++;
            updatedFixtureIds.push(fixtureId);
          }
        } catch (e) {
          console.error(`[LINEUPS] Error for fixture ${fixtureId}:`, e.message);
        }
      }));
    }

    // Track API calls
    const callDocId = `apiCalls-${today}`;
    const callDoc = await getFromSanity('appConfig', callDocId);
    const count = (callDoc?.count || 0) + apiCalls;
    await saveToSanity('appConfig', callDocId, { date: today, count });

    // Push real-time notification via Pusher
    if (updatedFixtureIds.length > 0) {
      await triggerEvent('match-updates', 'lineups-ready', {
        fixtureIds: updatedFixtureIds,
        date: today,
        timestamp: new Date().toISOString(),
      });
    }

    return Response.json({
      success: true,
      matchesChecked: matchesNearKickoff.length,
      updated,
      apiCalls,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[LINEUPS] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
