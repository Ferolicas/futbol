import { redisGet, redisSet, KEYS, TTL } from '../../../lib/redis';
import { ALL_LEAGUE_IDS } from '../../../lib/leagues';

// Force-refresh live data — direct API call, no cron chaining.
// Rate-limited to once every 15s via Redis lock.
// MERGES with existing live data — never destroys finished match stats.
// Accepts { date } in POST body — if viewing a past date, fixes stale entries.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const LOCK_KEY = 'refresh-live:lock';
const LOCK_TTL = 15;
const API_HOST = 'v3.football.api-sports.io';
const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];
const LIVE_STATUSES = ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT'];

const YOUTH_RE = /\bU-?1[2-9]\b|\bU-?2[0-3]\b|\bunder[ -]?(1[2-9]|2[0-3])\b|\byouth\b|\bjunior\b|\bsub-?(1[2-9]|2[0-3])\b/i;

function extractLiveStats(match) {
  const homeId = match.teams.home.id;
  const awayId = match.teams.away.id;
  const homeStats = (match.statistics || []).find(s => s.team?.id === homeId);
  const awayStats = (match.statistics || []).find(s => s.team?.id === awayId);

  const getVal = (teamStats, type) => {
    const stat = (teamStats?.statistics || []).find(s => s.type === type);
    return stat?.value || 0;
  };

  const goalScorers = [], cardEvents = [], missedPenalties = [];
  for (const ev of (match.events || [])) {
    if (ev.type === 'Goal') {
      if (ev.detail === 'Missed Penalty') {
        missedPenalties.push({ player: ev.player?.name, teamId: ev.team?.id, teamName: ev.team?.name, minute: ev.time?.elapsed, extra: ev.time?.extra });
      } else {
        goalScorers.push({ player: ev.player?.name, teamId: ev.team?.id, teamName: ev.team?.name, minute: ev.time?.elapsed, extra: ev.time?.extra, type: ev.detail });
      }
    }
    if (ev.type === 'Card') {
      cardEvents.push({ player: ev.player?.name, teamId: ev.team?.id, teamName: ev.team?.name, minute: ev.time?.elapsed, type: ev.detail });
    }
  }

  const hCorners = getVal(homeStats, 'Corner Kicks');
  const aCorners = getVal(awayStats, 'Corner Kicks');
  const hYellow = getVal(homeStats, 'Yellow Cards') || cardEvents.filter(e => e.teamId === homeId && e.type === 'Yellow Card').length;
  const aYellow = getVal(awayStats, 'Yellow Cards') || cardEvents.filter(e => e.teamId === awayId && e.type === 'Yellow Card').length;
  const hRed = getVal(homeStats, 'Red Cards') || cardEvents.filter(e => e.teamId === homeId && (e.type === 'Red Card' || e.type === 'Second Yellow card')).length;
  const aRed = getVal(awayStats, 'Red Cards') || cardEvents.filter(e => e.teamId === awayId && (e.type === 'Red Card' || e.type === 'Second Yellow card')).length;

  return {
    fixtureId: match.fixture.id,
    status: match.fixture.status,
    goals: match.goals,
    score: match.score,
    homeTeam: { id: homeId, name: match.teams.home.name },
    awayTeam: { id: awayId, name: match.teams.away.name },
    corners: { home: hCorners, away: aCorners, total: hCorners + aCorners },
    yellowCards: { home: hYellow, away: aYellow, total: hYellow + aYellow },
    redCards: { home: hRed, away: aRed, total: hRed + aRed },
    goalScorers,
    cardEvents,
    missedPenalties,
    updatedAt: new Date().toISOString(),
  };
}

async function apiFetchFixture(apiKey, fixtureId) {
  try {
    const res = await fetch(`https://${API_HOST}/fixtures?id=${fixtureId}`, {
      headers: { 'x-apisports-key': apiKey },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.response?.[0] || null;
  } catch { return null; }
}

export async function POST(request) {
  try {
    let body = {};
    try { body = await request.json(); } catch {}
    const viewDate = body.date || null;
    const force = body.force === true; // manual user press — bypass rate limit
    const today = new Date().toISOString().split('T')[0];

    // Rate limit — return cached data immediately if locked (unless manual force)
    const lock = await redisGet(LOCK_KEY);
    if (lock && !force) {
      const liveData = await redisGet(KEYS.liveStats(today));
      // Even when rate-limited, still return view date fixes
      let viewDateLiveStats = null;
      if (viewDate && viewDate !== today) {
        viewDateLiveStats = await redisGet(KEYS.liveStats(viewDate));
      }
      return Response.json({
        success: true,
        skipped: true,
        reason: 'Rate limited — returning cached data',
        liveStats: liveData && typeof liveData === 'object' ? liveData : {},
        viewDateLiveStats,
        timestamp: new Date().toISOString(),
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    // Manual force: use a 5s lock to prevent double-tap spam; automatic: 15s
    await redisSet(LOCK_KEY, '1', force ? 5 : LOCK_TTL);

    const apiKey = process.env.FOOTBALL_API_KEY;
    if (!apiKey) {
      return Response.json({ success: false, error: 'No API key configured' }, { status: 500 });
    }

    const res = await fetch(`https://${API_HOST}/fixtures?live=all`, {
      headers: { 'x-apisports-key': apiKey },
      cache: 'no-store',
    });

    let apiCalls = 1;

    if (!res.ok) {
      const cached = await redisGet(KEYS.liveStats(today));
      return Response.json({
        success: false,
        error: `API returned ${res.status}`,
        liveStats: cached && typeof cached === 'object' ? cached : {},
        timestamp: new Date().toISOString(),
      });
    }

    const json = await res.json();
    const tracked = (json.response || []).filter(m =>
      ALL_LEAGUE_IDS.includes(m.league.id) && !YOUTH_RE.test(m.league.name || '')
    );

    // Build fresh live data in the SAME format as cron/live (corners, yellowCards, etc.)
    const freshLive = {};
    for (const match of tracked) {
      const fid = match.fixture.id;
      const stats = extractLiveStats(match);
      stats.date = today;
      freshLive[fid] = stats;

      // Save individual fixture stats
      await redisSet(KEYS.fixtureStats(fid), stats, TTL.fixtureStats);
    }

    // Fetch individual fixtures for live matches missing statistics (no corners)
    // The ?live=all endpoint sometimes returns empty statistics for certain leagues
    const needsStatsFetch = tracked.filter(m => {
      const elapsed = m.fixture?.status?.elapsed || 0;
      if (elapsed < 10) return false; // too early, stats not available yet
      const hasStats = (m.statistics || []).length > 0;
      return !hasStats;
    });

    if (needsStatsFetch.length > 0) {
      await Promise.all(needsStatsFetch.map(async (match) => {
        const fid = match.fixture.id;
        const full = await apiFetchFixture(apiKey, fid);
        apiCalls++;
        if (full) {
          const fullStats = extractLiveStats(full);
          fullStats.date = today;
          freshLive[fid] = fullStats;
          await redisSet(KEYS.fixtureStats(fid), fullStats, TTL.fixtureStats);
        }
      }));
    }

    // MERGE with existing — never destroy finished match data
    const existing = await redisGet(KEYS.liveStats(today)) || {};
    const merged = { ...existing };
    const freshFids = new Set(Object.keys(freshLive));

    for (const [fid, data] of Object.entries(freshLive)) {
      const prev = merged[fid];
      merged[fid] = {
        ...data,
        // Preserve better data: keep existing corners/scorers if new ones are empty
        corners: data.corners?.total > 0 ? data.corners : (prev?.corners || data.corners),
        goalScorers: data.goalScorers?.length > 0 ? data.goalScorers : (prev?.goalScorers || []),
        missedPenalties: data.missedPenalties?.length > 0 ? data.missedPenalties : (prev?.missedPenalties || []),
      };
    }

    // Detect stale live statuses: matches that WERE live but are no longer in ?live=all.
    // Build kickoff map from fixtures:{date} cache — keep snapshot for Pass 2.
    const now = Date.now();
    let staleFixed = 0;

    const kickoffMap = {};
    let fixturesCacheSnapshot = null;
    try {
      const cf = await redisGet(KEYS.fixtures(today));
      if (Array.isArray(cf)) {
        fixturesCacheSnapshot = cf;
        for (const f of cf) {
          if (f.fixture?.id && f.fixture?.date) {
            kickoffMap[f.fixture.id] = new Date(f.fixture.date).getTime();
          }
        }
      }
    } catch {}

    // Pass 1: stale entries in merged (from liveStats cache, 2h TTL)
    // Any match that was live but is no longer in ?live=all needs its real status fetched.
    // No time gate — the time gate was causing matches with elapsed<85 to be missed.
    for (const [fid, entry] of Object.entries(merged)) {
      if (!LIVE_STATUSES.includes(entry.status?.short)) continue;
      if (freshFids.has(fid)) continue;
      // Skip if kicked off in the last 5 min — may not have appeared in live feed yet
      const kickoff = kickoffMap[fid] || 0;
      if (kickoff && (now - kickoff) < 5 * 60 * 1000) continue;
      const full = await apiFetchFixture(apiKey, Number(fid));
      apiCalls++;
      if (full && FINISHED_STATUSES.includes(full.fixture.status.short)) {
        const fullStats = extractLiveStats(full);
        fullStats.date = entry.date || today;
        fullStats.savedAt = new Date().toISOString();
        merged[fid] = fullStats;
        await redisSet(KEYS.fixtureStats(fid), fullStats, TTL.yesterday);
      } else if (!full) {
        // API returned nothing — force FT to stop showing as live
        merged[fid] = { ...entry, status: { short: 'FT', long: 'Match Finished', elapsed: 90 } };
      }
      // else: API confirms still live — keep current status
      staleFixed++;
    }

    // Pass 2: stale entries visible in fixtures cache but NOT in liveStats.
    // Root cause: liveStats TTL is 2h, fixtures cache TTL is 26h — after liveStats expires,
    // Pass 1 finds nothing but fixtures still show the old live status.
    // Also catches NS fixtures whose kickoff was >110min ago (match played but cron never
    // tracked it, e.g. lower-league night games not in ALL_LEAGUE_IDS live feed).
    if (fixturesCacheSnapshot) {
      const staleInFixtures = fixturesCacheSnapshot.filter(f => {
        const fid = String(f.fixture?.id);
        const status = f.fixture?.status?.short;
        const kickoff = f.fixture?.date ? new Date(f.fixture.date).getTime() : 0;
        const isStaleNs = status === 'NS' && kickoff > 0 && (now - kickoff) > 110 * 60 * 1000;
        return (LIVE_STATUSES.includes(status) || isStaleNs)
          && !freshFids.has(fid)
          && !FINISHED_STATUSES.includes(merged[fid]?.status?.short);
      });
      for (const f of staleInFixtures) {
        const fid = f.fixture.id;
        // Skip if kicked off in the last 5 min
        const kickoff = f.fixture.date ? new Date(f.fixture.date).getTime() : 0;
        if (kickoff && (now - kickoff) < 5 * 60 * 1000) continue;
        const full = await apiFetchFixture(apiKey, fid);
        apiCalls++;
        if (full) {
          const fullStats = extractLiveStats(full);
          fullStats.date = today;
          if (FINISHED_STATUSES.includes(full.fixture.status.short)) {
            fullStats.savedAt = new Date().toISOString();
            merged[String(fid)] = fullStats;
            await redisSet(KEYS.fixtureStats(fid), fullStats, TTL.yesterday);
            staleFixed++;
          } else if (f.fixture?.status?.short === 'NS' && kickoff > 0 && (now - kickoff) > 130 * 60 * 1000) {
            // API lag: lower leagues (e.g. B Metropolitana Argentina) can return NS for hours
            // after kickoff — the feed simply hasn't updated. Force-finish heuristically.
            // Spread fullStats to capture any events/stats the API does have (e.g. goals),
            // then override status to FT regardless.
            const forceEntry = {
              ...fullStats,
              status: { short: 'FT', long: 'Match Finished', elapsed: 90 },
              goals: fullStats.goals?.home != null ? fullStats.goals : (f.goals || fullStats.goals),
              score: fullStats.score || f.score,
              savedAt: new Date().toISOString(),
            };
            merged[String(fid)] = forceEntry;
            // Save to stats:{fid} so /api/fixtures needStats processing can find it
            // and won't make redundant API calls on subsequent page loads
            await redisSet(KEYS.fixtureStats(fid), forceEntry, TTL.yesterday);
            staleFixed++;
          } else {
            // API confirms still live or another non-finished state — update with fresh data
            merged[String(fid)] = fullStats;
          }
        } else {
          merged[String(fid)] = { fixtureId: fid, status: { short: 'FT', long: 'Match Finished', elapsed: 90 }, goals: f.goals, date: today };
          staleFixed++;
        }
      }
    }

    // Also update fixtures:{date} cache so fixture cards show correct status
    if (staleFixed > 0) {
      try {
        const cachedFixtures = await redisGet(KEYS.fixtures(today));
        if (Array.isArray(cachedFixtures)) {
          let changed = false;
          const updated = cachedFixtures.map(f => {
            const fid = f.fixture?.id;
            const liveEntry = merged[fid];
            if (liveEntry && FINISHED_STATUSES.includes(liveEntry.status?.short) &&
                !FINISHED_STATUSES.includes(f.fixture?.status?.short)) {
              changed = true;
              return {
                ...f,
                fixture: { ...f.fixture, status: liveEntry.status },
                goals: liveEntry.goals || f.goals,
                score: liveEntry.score || f.score,
              };
            }
            return f;
          });
          if (changed) await redisSet(KEYS.fixtures(today), updated, 48 * 3600);
        }
      } catch {}
    }

    await redisSet(KEYS.liveStats(today), merged, TTL.liveStats);

    // ===== Handle viewed date (past dates — e.g., yesterday) =====
    // Fix stale entries: matches that show as live but are actually finished
    let viewDateLiveStats = null;
    let viewDateStaleFixed = 0;

    if (viewDate && viewDate !== today) {
      const viewExisting = await redisGet(KEYS.liveStats(viewDate)) || {};
      let viewChanged = false;

      const staleEntries = Object.entries(viewExisting).filter(
        ([, entry]) => LIVE_STATUSES.includes(entry.status?.short)
      );

      if (staleEntries.length > 0) {
        await Promise.all(staleEntries.map(async ([fid, entry]) => {
          const full = await apiFetchFixture(apiKey, Number(fid));
          apiCalls++;
          if (full) {
            const fullStats = extractLiveStats(full);
            fullStats.date = viewDate;
            if (FINISHED_STATUSES.includes(full.fixture.status.short)) {
              fullStats.savedAt = new Date().toISOString();
            }
            viewExisting[fid] = fullStats;
            viewChanged = true;
            viewDateStaleFixed++;
            await redisSet(KEYS.fixtureStats(fid), fullStats, TTL.yesterday);
          }
        }));
      }

      // Pass 2 for viewDate: scan fixtures cache — liveStats TTL (2h) may have expired
      // but fixtures cache (26h) still shows stale live or NS status
      try {
        const viewFixtures = await redisGet(KEYS.fixtures(viewDate));
        if (Array.isArray(viewFixtures)) {
          const viewNow = Date.now();
          const staleInViewFixtures = viewFixtures.filter(f => {
            const fid = String(f.fixture?.id);
            const status = f.fixture?.status?.short;
            const kickoff = f.fixture?.date ? new Date(f.fixture.date).getTime() : 0;
            const isStaleNs = status === 'NS' && kickoff > 0 && (viewNow - kickoff) > 110 * 60 * 1000;
            return (LIVE_STATUSES.includes(status) || isStaleNs)
              && !FINISHED_STATUSES.includes(viewExisting[fid]?.status?.short);
          });
          for (const f of staleInViewFixtures) {
            const fid = f.fixture.id;
            const vKickoff = f.fixture?.date ? new Date(f.fixture.date).getTime() : 0;
            const full = await apiFetchFixture(apiKey, fid);
            apiCalls++;
            if (full) {
              const fullStats = extractLiveStats(full);
              fullStats.date = viewDate;
              if (FINISHED_STATUSES.includes(full.fixture.status.short)) {
                fullStats.savedAt = new Date().toISOString();
                viewExisting[String(fid)] = fullStats;
                viewChanged = true;
                viewDateStaleFixed++;
                await redisSet(KEYS.fixtureStats(fid), fullStats, TTL.yesterday);
              } else if (f.fixture?.status?.short === 'NS' && vKickoff > 0 && (viewNow - vKickoff) > 130 * 60 * 1000) {
                // API lag for lower leagues — force-finish heuristically
                const forceEntry = {
                  ...fullStats,
                  status: { short: 'FT', long: 'Match Finished', elapsed: 90 },
                  goals: fullStats.goals?.home != null ? fullStats.goals : (f.goals || fullStats.goals),
                  score: fullStats.score || f.score,
                  savedAt: new Date().toISOString(),
                };
                viewExisting[String(fid)] = forceEntry;
                await redisSet(KEYS.fixtureStats(fid), forceEntry, TTL.yesterday);
                viewChanged = true;
                viewDateStaleFixed++;
              } else {
                viewExisting[String(fid)] = fullStats;
                viewChanged = true;
                viewDateStaleFixed++;
                await redisSet(KEYS.fixtureStats(fid), fullStats, TTL.yesterday);
              }
            } else {
              // API returned nothing — force-finish to stop showing as live
              viewExisting[String(fid)] = {
                fixtureId: fid,
                status: { short: 'FT', long: 'Match Finished', elapsed: 90 },
                goals: f.goals,
                date: viewDate,
              };
              viewChanged = true;
              viewDateStaleFixed++;
            }
          }
        }
      } catch (e) {
        console.error('[REFRESH-LIVE] Pass2 viewDate error:', e.message);
      }

      if (viewChanged) {
        await redisSet(KEYS.liveStats(viewDate), viewExisting, 48 * 3600);
        // Also update fixtures cache for the viewed date
        try {
          const cachedFixtures = await redisGet(KEYS.fixtures(viewDate));
          if (Array.isArray(cachedFixtures)) {
            let fxChanged = false;
            const updated = cachedFixtures.map(f => {
              const fid = f.fixture?.id;
              const liveEntry = viewExisting[fid];
              if (liveEntry && FINISHED_STATUSES.includes(liveEntry.status?.short) &&
                  !FINISHED_STATUSES.includes(f.fixture?.status?.short)) {
                fxChanged = true;
                return {
                  ...f,
                  fixture: { ...f.fixture, status: liveEntry.status },
                  goals: liveEntry.goals || f.goals,
                  score: liveEntry.score || f.score,
                };
              }
              return f;
            });
            if (fxChanged) await redisSet(KEYS.fixtures(viewDate), updated, 48 * 3600);
          }
        } catch {}
      }

      viewDateLiveStats = viewExisting;
    }

    return Response.json({
      success: true,
      liveCount: tracked.length,
      liveStats: merged,
      viewDateLiveStats,
      viewDateStaleFixed,
      apiCalls,
      staleFixed,
      timestamp: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });

  } catch (error) {
    console.error('[REFRESH-LIVE] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
