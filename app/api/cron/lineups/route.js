import { getFromSanity, saveToSanity } from '../../../../lib/sanity';
import { getCachedAnalysis, cacheAnalysis } from '../../../../lib/sanity-cache';
import { ALL_LEAGUE_IDS } from '../../../../lib/leagues';
import { computeAllProbabilities } from '../../../../lib/calculations';
import { buildCombinada } from '../../../../lib/combinada';
import { triggerEvent } from '../../../../lib/pusher';

// Smart Lineup Fetch: runs every 5 minutes
// 1. Finds matches ~45 min from kickoff
// 2. Fetches lineups + injuries from API-Football
// 3. Compares confirmed lineup vs usual XI (from last 5 matches)
// 4. If 2+ usual starters are absent → marks analysis as NEGATIVE
// 5. Emits Pusher events: lineup-confirmed + analysis-updated
// FALLBACK: If no prior analysis exists, fetches last 5 matches on the fly
//           to derive the usual XI, so detection ALWAYS runs.

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

async function fetchFromApi(endpoint) {
  const key = getApiKey();
  if (!key) return null;

  const res = await fetch(`https://${API_HOST}${endpoint}`, {
    headers: { 'x-apisports-key': key },
    cache: 'no-store',
  });

  if (!res.ok) return null;
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) return null;
  return data.response || [];
}

async function fetchLineups(fixtureId) {
  return fetchFromApi(`/fixtures/lineups?fixture=${fixtureId}`);
}

async function fetchInjuries(fixtureId) {
  return fetchFromApi(`/injuries?fixture=${fixtureId}`);
}

/**
 * Fetch last 5 finished matches for a team and derive the usual XI.
 * This is the FALLBACK path — used when no prior analysis exists.
 * Returns { usualXI: Array, apiCalls: number }
 */
async function deriveUsualXIOnTheFly(teamId) {
  const season = new Date().getMonth() >= 6
    ? new Date().getFullYear()
    : new Date().getFullYear() - 1;

  let calls = 0;

  // Fetch team's fixtures for the season
  const fixtures = await fetchFromApi(`/fixtures?team=${teamId}&season=${season}`);
  calls++;
  if (!fixtures || fixtures.length === 0) return { usualXI: [], apiCalls: calls };

  // Filter to finished matches, take last 5
  const FINISHED = ['FT', 'AET', 'PEN'];
  const finished = fixtures
    .filter(f => FINISHED.includes(f.fixture?.status?.short))
    .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
    .slice(0, 5);

  if (finished.length === 0) return { usualXI: [], apiCalls: calls };

  // Fetch player stats for each of those matches
  const fixtureIds = finished.map(f => f.fixture.id);
  const playersByMatch = {};

  // Fetch in batches of 5
  for (let i = 0; i < fixtureIds.length; i += 5) {
    const batch = fixtureIds.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(fid => fetchFromApi(`/fixtures/players?fixture=${fid}`))
    );
    calls += batch.length;
    batch.forEach((fid, idx) => {
      playersByMatch[fid] = results[idx] || [];
    });
  }

  // Derive usual XI: count appearances per player
  const playerAppearances = {};

  for (const fid of fixtureIds) {
    const matchData = playersByMatch[fid];
    if (!matchData || !Array.isArray(matchData)) continue;

    for (const teamData of matchData) {
      if (teamData.team?.id !== teamId) continue;
      for (const p of (teamData.players || [])) {
        const pid = p.player?.id;
        if (!pid) continue;

        const minutes = p.statistics?.[0]?.games?.minutes || 0;
        if (minutes <= 0) continue;

        if (!playerAppearances[pid]) {
          playerAppearances[pid] = {
            id: pid,
            name: p.player?.name || '?',
            photo: p.player?.photo,
            position: p.statistics?.[0]?.games?.position || 'N/A',
            appearances: 0,
            totalMinutes: 0,
          };
        }
        playerAppearances[pid].appearances++;
        playerAppearances[pid].totalMinutes += minutes;
      }
    }
  }

  const usualXI = Object.values(playerAppearances)
    .sort((a, b) => b.appearances - a.appearances || b.totalMinutes - a.totalMinutes)
    .slice(0, 11);

  return { usualXI, apiCalls: calls };
}

/**
 * Compare confirmed lineup vs usual XI.
 * Returns missing usual starters for each team.
 */
function detectMissingStarters(lineups, usualXI, teamId) {
  if (!lineups || !Array.isArray(lineups) || !usualXI || usualXI.length === 0) {
    return { missing: [], count: 0 };
  }

  // Find this team's confirmed lineup
  const teamLineup = lineups.find(l => l.team?.id === teamId);
  if (!teamLineup?.startXI) return { missing: [], count: 0 };

  // Get IDs of confirmed starters
  const confirmedIds = new Set(
    teamLineup.startXI.map(p => p.player?.id).filter(Boolean)
  );

  // Find usual starters NOT in the confirmed lineup
  // "Usual starter" = appeared in 70%+ of last 5 matches (≥ 4 of 5, or ≥ 3 of 4, etc.)
  const threshold = Math.ceil(usualXI.length > 0 ? (usualXI[0]?.appearances || 5) * 0.7 : 3);
  const usualStarters = usualXI.filter(p => (p.appearances || 0) >= threshold);

  const missing = usualStarters.filter(p => !confirmedIds.has(p.id));

  return {
    missing: missing.map(p => ({
      id: p.id,
      name: p.name,
      position: p.position,
      appearances: p.appearances,
    })),
    count: missing.length,
    totalUsual: usualStarters.length,
    totalConfirmed: confirmedIds.size,
  };
}

/**
 * Process a single match: detect missing starters, update analysis, emit events.
 * Works with EITHER cached analysis or freshly derived usual XI.
 */
function buildImpacts(lineups, homeUsualXI, awayUsualXI, homeId, awayId, homeTeam, awayTeam) {
  const homeMissing = detectMissingStarters(lineups, homeUsualXI, homeId);
  const awayMissing = detectMissingStarters(lineups, awayUsualXI, awayId);

  const impacts = [];
  if (homeMissing.count >= 2) {
    impacts.push({
      team: 'home',
      teamName: homeTeam,
      impact: 'NEGATIVE',
      missingPlayers: homeMissing.missing.map(p => p.name),
      missingCount: homeMissing.count,
      reason: `${homeMissing.count} titulares habituales ausentes`,
    });
  }
  if (awayMissing.count >= 2) {
    impacts.push({
      team: 'away',
      teamName: awayTeam,
      impact: 'NEGATIVE',
      missingPlayers: awayMissing.missing.map(p => p.name),
      missingCount: awayMissing.count,
      reason: `${awayMissing.count} titulares habituales ausentes`,
    });
  }

  return { impacts, homeMissing, awayMissing };
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

    // Find matches that are within [kickoff - 50min, kickoff] window
    const matchesNearKickoff = cached.matches.filter(m => {
      if (m.fixture.status.short !== 'NS') return false;
      const kickoff = new Date(m.fixture.date).getTime();
      const timeUntil = kickoff - now;
      return timeUntil > 0 && timeUntil <= WINDOW_MS + TOLERANCE_MS;
    });

    if (matchesNearKickoff.length === 0) {
      return Response.json({ success: true, message: 'No matches near kickoff', updated: 0 });
    }

    console.log(`[LINEUPS] ${matchesNearKickoff.length} matches within 50min of kickoff`);

    let updated = 0;
    let apiCalls = 0;
    let fallbackCount = 0;
    const updatedFixtureIds = [];
    const lineupImpacts = [];

    for (let i = 0; i < matchesNearKickoff.length; i += 5) {
      const batch = matchesNearKickoff.slice(i, i + 5);

      await Promise.all(batch.map(async (match) => {
        const fixtureId = match.fixture.id;
        const homeId = match.teams?.home?.id;
        const awayId = match.teams?.away?.id;
        const homeTeam = match.teams?.home?.name || 'Home';
        const awayTeam = match.teams?.away?.name || 'Away';

        try {
          const [lineups, injuries] = await Promise.all([
            fetchLineups(fixtureId),
            fetchInjuries(fixtureId),
          ]);
          apiCalls += 2;

          // Skip if no lineups available yet
          if (!lineups || lineups.length === 0) return;

          const existing = await getCachedAnalysis(fixtureId, today);

          if (existing) {
            // ===== PATH A: Analysis exists — use cached usual XI =====
            const updatedAnalysis = {
              ...existing,
              lineups: { available: true, data: lineups },
              injuries: injuries || existing.injuries,
              lineupsUpdatedAt: new Date().toISOString(),
              hasLineup: true,
            };

            const eHomeId = existing.homeId || homeId;
            const eAwayId = existing.awayId || awayId;
            const { impacts, homeMissing, awayMissing } = buildImpacts(
              lineups, existing.homeUsualXI, existing.awayUsualXI,
              eHomeId, eAwayId,
              existing.homeTeam || homeTeam, existing.awayTeam || awayTeam
            );

            updatedAnalysis.lineupImpact = impacts.length > 0 ? impacts : null;
            updatedAnalysis.lineupCheck = {
              homeMissing: homeMissing.missing,
              awayMissing: awayMissing.missing,
              checkedAt: new Date().toISOString(),
            };

            // Recalculate probabilities with updated data
            const probs = computeAllProbabilities(updatedAnalysis);
            updatedAnalysis.calculatedProbabilities = probs;
            const teamNames = { home: updatedAnalysis.homeTeam, away: updatedAnalysis.awayTeam };
            updatedAnalysis.combinada = buildCombinada(probs, updatedAnalysis.odds, updatedAnalysis.playerHighlights, teamNames);

            await cacheAnalysis(fixtureId, updatedAnalysis);
            updated++;
            updatedFixtureIds.push(fixtureId);

            if (impacts.length > 0) {
              lineupImpacts.push({ fixtureId, impacts });
            }
          } else {
            // ===== PATH B: NO analysis exists — FALLBACK =====
            // Derive usual XI on the fly from API-Football last 5 matches
            console.log(`[LINEUPS] No analysis for fixture ${fixtureId} — running fallback XI derivation`);
            fallbackCount++;

            const [homeDerived, awayDerived] = await Promise.all([
              deriveUsualXIOnTheFly(homeId),
              deriveUsualXIOnTheFly(awayId),
            ]);
            apiCalls += homeDerived.apiCalls + awayDerived.apiCalls;

            const { impacts, homeMissing, awayMissing } = buildImpacts(
              lineups, homeDerived.usualXI, awayDerived.usualXI,
              homeId, awayId, homeTeam, awayTeam
            );

            // Save lineups + detection results even without full analysis
            await saveToSanity('matchLineups', String(fixtureId), {
              fixtureId,
              lineups,
              injuries,
              homeUsualXI: homeDerived.usualXI,
              awayUsualXI: awayDerived.usualXI,
              lineupImpact: impacts.length > 0 ? impacts : null,
              lineupCheck: {
                homeMissing: homeMissing.missing,
                awayMissing: awayMissing.missing,
                checkedAt: new Date().toISOString(),
              },
              fallback: true,
              fetchedAt: new Date().toISOString(),
            });
            updated++;
            updatedFixtureIds.push(fixtureId);

            if (impacts.length > 0) {
              lineupImpacts.push({ fixtureId, impacts });
              console.log(`[LINEUPS] FALLBACK detected NEGATIVE impact for fixture ${fixtureId}:`,
                impacts.map(i => `${i.teamName}: ${i.missingCount} absent`).join(', '));
            }
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

    // Emit Pusher events
    if (updatedFixtureIds.length > 0) {
      // Notify: lineups are confirmed
      await triggerEvent('match-updates', 'lineups-ready', {
        fixtureIds: updatedFixtureIds,
        date: today,
        timestamp: new Date().toISOString(),
      });

      // If any match has negative lineup impact, emit analysis-updated
      if (lineupImpacts.length > 0) {
        await triggerEvent('match-updates', 'analysis-updated', {
          date: today,
          impacts: lineupImpacts,
          timestamp: new Date().toISOString(),
        });
      }
    }

    return Response.json({
      success: true,
      matchesChecked: matchesNearKickoff.length,
      updated,
      apiCalls,
      fallbackCount,
      lineupImpacts: lineupImpacts.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[LINEUPS] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
