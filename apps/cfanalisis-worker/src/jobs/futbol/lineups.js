// @ts-nocheck
/**
 * Job: futbol-lineups
 * Port of /api/cron/lineups. Runs near match kickoff — fetches lineups + injuries
 * for matches starting within ~50 minutes, derives usualXI if missing, computes
 * lineup impact (missing starters), and refreshes analysis.
 *
 * Payload: {}
 */
import {
  getCachedAnalysis, cacheAnalysis, incrementApiCallCount,
  computeAllProbabilities, buildCombinada, triggerEvent,
  redisGet, redisSet, KEYS, getMatchSchedule,
} from '../../shared.js';
import { mapPool } from '../../pool.js';
import { logError } from '../../errors-log.js';

// All matches in the 50-min window are processed concurrently. The shared
// rate limiter in lib/api-football.js still throttles actual HTTP starts.
const LINEUPS_CONCURRENCY = 15;

const API_HOST = 'v3.football.api-sports.io';

async function fetchFromApi(endpoint) {
  const key = process.env.FOOTBALL_API_KEY;
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

async function deriveUsualXIOnTheFly(teamId) {
  const cacheKey = `usualxi:${teamId}`;
  const cachedXI = await redisGet(cacheKey);
  if (cachedXI && Array.isArray(cachedXI) && cachedXI.length > 0) {
    return { usualXI: cachedXI, apiCalls: 0 };
  }

  const season = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  let calls = 0;

  const fixtures = await fetchFromApi(`/fixtures?team=${teamId}&season=${season}`);
  calls++;
  if (!fixtures?.length) return { usualXI: [], apiCalls: calls };

  const FINISHED = ['FT', 'AET', 'PEN'];
  const finished = fixtures.filter(f => FINISHED.includes(f.fixture?.status?.short)).sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date)).slice(0, 5);
  if (finished.length === 0) return { usualXI: [], apiCalls: calls };

  const fixtureIds = finished.map(f => f.fixture.id);
  const playersByMatch = {};
  for (let i = 0; i < fixtureIds.length; i += 5) {
    const batch = fixtureIds.slice(i, i + 5);
    const results = await Promise.all(batch.map(fid => fetchFromApi(`/fixtures/players?fixture=${fid}`)));
    calls += batch.length;
    batch.forEach((fid, idx) => { playersByMatch[fid] = results[idx] || []; });
  }

  const playerAppearances = {};
  for (const fid of fixtureIds) {
    const matchData = playersByMatch[fid];
    if (!matchData) continue;
    for (const teamData of matchData) {
      if (teamData.team?.id !== teamId) continue;
      for (const p of (teamData.players || [])) {
        const pid = p.player?.id;
        if (!pid) continue;
        const minutes = p.statistics?.[0]?.games?.minutes || 0;
        if (minutes <= 0) continue;
        if (!playerAppearances[pid]) {
          playerAppearances[pid] = { id: pid, name: p.player?.name || '?', photo: p.player?.photo, position: p.statistics?.[0]?.games?.position || 'N/A', appearances: 0, totalMinutes: 0 };
        }
        playerAppearances[pid].appearances++;
        playerAppearances[pid].totalMinutes += minutes;
      }
    }
  }

  const usualXI = Object.values(playerAppearances).sort((a, b) => b.appearances - a.appearances || b.totalMinutes - a.totalMinutes).slice(0, 11);
  if (usualXI.length > 0) await redisSet(cacheKey, usualXI, 86400);
  return { usualXI, apiCalls: calls };
}

function detectMissingStarters(lineups, usualXI, teamId) {
  if (!lineups || !Array.isArray(lineups) || !usualXI?.length) return { missing: [], count: 0 };
  const teamLineup = lineups.find(l => l.team?.id === teamId);
  if (!teamLineup?.startXI) return { missing: [], count: 0 };
  const confirmedIds = new Set(teamLineup.startXI.map(p => p.player?.id).filter(Boolean));
  const threshold = Math.ceil((usualXI[0]?.appearances || 5) * 0.7);
  const usualStarters = usualXI.filter(p => (p.appearances || 0) >= threshold);
  const missing = usualStarters.filter(p => !confirmedIds.has(p.id));
  return { missing: missing.map(p => ({ id: p.id, name: p.name, position: p.position, appearances: p.appearances })), count: missing.length, totalUsual: usualStarters.length, totalConfirmed: confirmedIds.size };
}

function buildImpacts(lineups, homeUsualXI, awayUsualXI, homeId, awayId, homeTeam, awayTeam) {
  const homeMissing = detectMissingStarters(lineups, homeUsualXI, homeId);
  const awayMissing = detectMissingStarters(lineups, awayUsualXI, awayId);
  const impacts = [];
  if (homeMissing.count >= 2) impacts.push({ team: 'home', teamName: homeTeam, impact: 'NEGATIVE', missingPlayers: homeMissing.missing.map(p => p.name), missingCount: homeMissing.count, reason: `${homeMissing.count} titulares habituales ausentes` });
  if (awayMissing.count >= 2) impacts.push({ team: 'away', teamName: awayTeam, impact: 'NEGATIVE', missingPlayers: awayMissing.missing.map(p => p.name), missingCount: awayMissing.count, reason: `${awayMissing.count} titulares habituales ausentes` });
  return { impacts, homeMissing, awayMissing };
}

/** @param {any} _payload @param {any} [_job] */
export async function runLineups(_payload = {}, _job = null) {
  const today = new Date().toISOString().split('T')[0];
  const now = Date.now();
  const WINDOW_MS = 45 * 60 * 1000;
  const TOLERANCE_MS = 5 * 60 * 1000;

  let schedule = await redisGet(KEYS.schedule(today));
  if (!schedule) schedule = await getMatchSchedule(today).catch(() => null);

  const cachedFixtures = await redisGet(KEYS.fixtures(today));

  if (!schedule && cachedFixtures?.length > 0) {
    const kickoffTimes = cachedFixtures.map(f => {
      const kickoff = new Date(f.fixture.date).getTime();
      return { fixtureId: f.fixture.id, kickoff, expectedEnd: kickoff + 120 * 60 * 1000 };
    }).sort((a, b) => a.kickoff - b.kickoff);
    schedule = { kickoffTimes, firstKickoff: kickoffTimes[0].kickoff, lastExpectedEnd: Math.max(...kickoffTimes.map(k => k.expectedEnd)) };
  } else if (!schedule && cachedFixtures && cachedFixtures.length === 0) {
    schedule = { kickoffTimes: [], firstKickoff: null, lastExpectedEnd: null };
  }

  if (schedule) {
    if (!schedule.kickoffTimes?.length) {
      return { ok: true, skipped: true, reason: 'no fixtures today', updated: 0, apiCalls: 0 };
    }
    const hasMatchInWindow = schedule.kickoffTimes.some(m => {
      const timeUntilKickoff = m.kickoff - now;
      return timeUntilKickoff > 0 && timeUntilKickoff <= WINDOW_MS + TOLERANCE_MS;
    });
    if (!hasMatchInWindow) {
      return { ok: true, skipped: true, reason: 'no matches within 50min of kickoff', updated: 0, apiCalls: 0 };
    }
  }

  if (!cachedFixtures?.length) {
    return { ok: true, message: 'no fixtures cached', updated: 0 };
  }

  const matchesNearKickoff = cachedFixtures.filter(m => {
    if (m.fixture.status.short !== 'NS') return false;
    const kickoff = new Date(m.fixture.date).getTime();
    const timeUntil = kickoff - now;
    return timeUntil > 0 && timeUntil <= WINDOW_MS + TOLERANCE_MS;
  });

  if (matchesNearKickoff.length === 0) {
    return { ok: true, message: 'no matches near kickoff', updated: 0 };
  }

  let updated = 0, apiCalls = 0, fallbackCount = 0;
  const updatedFixtureIds = [], lineupImpacts = [], errors = [];

  const results = await mapPool(matchesNearKickoff, LINEUPS_CONCURRENCY, async (match) => {
    const fixtureId = match.fixture.id;
    const homeId = match.teams?.home?.id, awayId = match.teams?.away?.id;
    const homeTeam = match.teams?.home?.name || 'Home', awayTeam = match.teams?.away?.name || 'Away';

    const [lineups, injuries] = await Promise.all([
      fetchFromApi(`/fixtures/lineups?fixture=${fixtureId}`),
      fetchFromApi(`/injuries?fixture=${fixtureId}`),
    ]);
    apiCalls += 2;
    if (!lineups?.length) return { fixtureId, skipped: true };

    const existing = await getCachedAnalysis(fixtureId, today);
    if (existing) {
      const updatedAnalysis = {
        ...existing,
        lineups: { available: true, data: lineups },
        injuries: injuries || existing.injuries,
        lineupsUpdatedAt: new Date().toISOString(),
        hasLineup: true,
      };
      const eHomeId = existing.homeId || homeId, eAwayId = existing.awayId || awayId;
      const { impacts, homeMissing, awayMissing } = buildImpacts(
        lineups, existing.homeUsualXI, existing.awayUsualXI,
        eHomeId, eAwayId, existing.homeTeam || homeTeam, existing.awayTeam || awayTeam,
      );
      updatedAnalysis.lineupImpact = impacts.length > 0 ? impacts : null;
      updatedAnalysis.lineupCheck = {
        homeMissing: homeMissing.missing,
        awayMissing: awayMissing.missing,
        checkedAt: new Date().toISOString(),
      };
      const probs = computeAllProbabilities(updatedAnalysis);
      updatedAnalysis.calculatedProbabilities = probs;
      const teamNames = { home: updatedAnalysis.homeTeam, away: updatedAnalysis.awayTeam };
      updatedAnalysis.combinada = buildCombinada(probs, updatedAnalysis.odds, updatedAnalysis.playerHighlights, teamNames);
      await cacheAnalysis(fixtureId, updatedAnalysis);
      updated++;
      updatedFixtureIds.push(fixtureId);
      if (impacts.length > 0) lineupImpacts.push({ fixtureId, impacts });
      return { fixtureId, skipped: false, fallback: false };
    }

    fallbackCount++;
    const [homeDerived, awayDerived] = await Promise.all([
      deriveUsualXIOnTheFly(homeId),
      deriveUsualXIOnTheFly(awayId),
    ]);
    apiCalls += homeDerived.apiCalls + awayDerived.apiCalls;
    const { impacts, homeMissing, awayMissing } = buildImpacts(
      lineups, homeDerived.usualXI, awayDerived.usualXI,
      homeId, awayId, homeTeam, awayTeam,
    );
    await redisSet(`lineups:${fixtureId}`, {
      fixtureId, lineups, injuries,
      homeUsualXI: homeDerived.usualXI,
      awayUsualXI: awayDerived.usualXI,
      lineupImpact: impacts.length > 0 ? impacts : null,
      lineupCheck: {
        homeMissing: homeMissing.missing,
        awayMissing: awayMissing.missing,
        checkedAt: new Date().toISOString(),
      },
      fetchedAt: new Date().toISOString(),
    }, 7200);
    updated++;
    updatedFixtureIds.push(fixtureId);
    if (impacts.length > 0) lineupImpacts.push({ fixtureId, impacts });
    return { fixtureId, skipped: false, fallback: true };
  });

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.ok) {
      const m = matchesNearKickoff[i];
      const fid = m.fixture.id;
      errors.push({ fixtureId: fid, error: r.error.message });
      console.error(`[job:futbol-lineups] failed ${fid}:`, r.error.message);
      await logError(today, {
        job: 'futbol-lineups',
        fixtureId: fid,
        homeTeam: m.teams?.home?.name,
        awayTeam: m.teams?.away?.name,
        league: m.league?.name,
        kickoff: m.fixture?.date,
        error: r.error.message,
      });
    }
  }

  for (let i = 0; i < apiCalls; i++) await incrementApiCallCount();

  if (updatedFixtureIds.length > 0) {
    await triggerEvent('match-updates', 'lineups-ready', { fixtureIds: updatedFixtureIds, date: today, timestamp: new Date().toISOString() });
    if (lineupImpacts.length > 0) {
      await triggerEvent('match-updates', 'analysis-updated', { date: today, impacts: lineupImpacts, timestamp: new Date().toISOString() });
    }
  }

  // If a meaningful share of the window failed, throw so BullMQ retries.
  // Tolerate sporadic API hiccups: only retry if >25% failed (rare).
  if (errors.length > 0 && errors.length / matchesNearKickoff.length > 0.25) {
    throw new Error(`lineups partial failure: ${errors.length}/${matchesNearKickoff.length}`);
  }

  return {
    ok: true,
    matchesChecked: matchesNearKickoff.length,
    updated,
    apiCalls,
    fallbackCount,
    lineupImpacts: lineupImpacts.length,
    errors: errors.length,
  };
}
