import { getFromSanity, saveToSanity } from '../../../../lib/sanity';
import { getCachedAnalysis, cacheAnalysis } from '../../../../lib/sanity-cache';
import { ALL_LEAGUE_IDS } from '../../../../lib/leagues';
import { computeAllProbabilities } from '../../../../lib/calculations';
import { buildCombinada } from '../../../../lib/combinada';

// Smart Fetch: runs every 5 minutes
// Checks which matches are 45 min from kickoff, fetches lineups + injuries in bulk
// Vercel cron schedule: "*/5 * * * *"

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const API_HOST = 'v3.football.api-sports.io';

function getApiKey() {
  return process.env.FOOTBALL_API_KEY;
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
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const now = Date.now();
    const WINDOW_MS = 45 * 60 * 1000; // 45 minutes
    const TOLERANCE_MS = 5 * 60 * 1000; // 5 min tolerance (since cron runs every 5 min)

    // Get today's fixtures
    const cached = await getFromSanity('matchDay', today);
    if (!cached?.matches) {
      return Response.json({ success: true, message: 'No fixtures cached', updated: 0 });
    }

    // Find matches that are ~45 min from kickoff
    const matchesNearKickoff = cached.matches.filter(m => {
      if (m.fixture.status.short !== 'NS') return false; // Only upcoming
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

    // Fetch lineups and injuries for each match (parallel batches of 5)
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

          // Get existing analysis if any
          const existing = await getCachedAnalysis(fixtureId, today);

          if (existing) {
            // Update analysis with lineups and injuries, recalculate
            const updatedAnalysis = {
              ...existing,
              lineups: lineups || existing.lineups,
              injuries: injuries || existing.injuries,
              lineupsUpdatedAt: new Date().toISOString(),
            };

            // Recalculate probabilities with lineup data
            const probs = computeAllProbabilities(updatedAnalysis);
            updatedAnalysis.calculatedProbabilities = probs;
            updatedAnalysis.combinada = buildCombinada(probs, updatedAnalysis.odds, updatedAnalysis.playerHighlights);

            await cacheAnalysis(fixtureId, updatedAnalysis);
            updated++;
          } else {
            // Store lineups even without full analysis
            await saveToSanity('matchLineups', String(fixtureId), {
              fixtureId,
              lineups,
              injuries,
              fetchedAt: new Date().toISOString(),
            });
            updated++;
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
