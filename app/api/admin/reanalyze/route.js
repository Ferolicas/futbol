/**
 * /api/admin/reanalyze
 *
 * POST (session auth)   → validates owner, kicks off the server-side chain, returns immediately.
 *                         Browser can close — execution continues on Vercel.
 * POST (x-internal-trigger) → processes one batch of 10, chains itself to the next offset.
 * GET  (session auth)   → returns current progress from Redis for frontend polling.
 */
import { analyzeMatch, getFixtures, fetchMatchStats, resetRateLimiter } from '../../../../lib/api-football';
import { getCachedAnalysis } from '../../../../lib/sanity-cache';
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../../lib/supabase';
import { redisGet, redisSet, KEYS, TTL } from '../../../../lib/redis';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const OWNER_EMAIL      = 'ferneyolicas@gmail.com';
const BATCH_SIZE       = 10;
const PROGRESS_TTL     = 4 * 3600; // keep progress visible for 4 hours

const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']);
const LIVE_STATUSES     = new Set(['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE', 'INT']);

// ─── helpers ──────────────────────────────────────────────────────────────────

function compactLastFive(lastFive) {
  if (!Array.isArray(lastFive)) return [];
  return lastFive.map(m => {
    const e = m._enriched || {};
    return {
      r: e.result, s: e.score, gF: e.goalsFor, gA: e.goalsAgainst,
      op: e.opponentName, oL: e.opponentLogo,
      c: e.corners, y: e.yellowCards, rd: e.redCards,
    };
  });
}

function buildSummary(a) {
  return {
    fixtureId: a.fixtureId, homeTeam: a.homeTeam, awayTeam: a.awayTeam,
    homeLogo: a.homeLogo, awayLogo: a.awayLogo, homeId: a.homeId, awayId: a.awayId,
    league: a.league, leagueId: a.leagueId, leagueLogo: a.leagueLogo,
    kickoff: a.kickoff, status: a.status, goals: a.goals, odds: a.odds,
    combinada: a.combinada, calculatedProbabilities: a.calculatedProbabilities,
    homePosition: a.homePosition, awayPosition: a.awayPosition,
    homeLastFive: compactLastFive(a.homeLastFive),
    awayLastFive: compactLastFive(a.awayLastFive),
    playerHighlights: a.playerHighlights || null,
  };
}

function getBaseUrl() {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  if (process.env.NEXTAUTH_URL)        return process.env.NEXTAUTH_URL;
  if (process.env.VERCEL_URL)          return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

// ─── GET — progress polling ────────────────────────────────────────────────────

export async function GET(request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.email?.toLowerCase() !== OWNER_EMAIL) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || new Date().toISOString().split('T')[0];

  const progress = await redisGet(`reanalyze-progress:${date}`);
  return Response.json(progress || { running: false, completed: false });
}

// ─── POST — start (session) or continue batch (internal) ─────────────────────

export async function POST(request) {
  const isInternal = request.headers.get('x-internal-trigger') === 'true';

  // Internal batch calls skip session auth
  if (!isInternal) {
    const supabase = createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return Response.json({ error: 'Not authenticated' }, { status: 401 });
    if (user.email?.toLowerCase() !== OWNER_EMAIL) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const { searchParams } = new URL(request.url);
  const date   = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const offset = parseInt(searchParams.get('offset') || '0', 10);

  // ── offset=0 AND called from browser: set up and kick off chain, return immediately ──
  if (offset === 0 && !isInternal) {
    // Check if already running
    const current = await redisGet(`reanalyze-progress:${date}`);
    if (current?.running) {
      return Response.json({ started: false, message: 'Already running', progress: current });
    }

    // Ensure fixtures are in Redis (fetch from API only if missing)
    let fixtures = await redisGet(KEYS.fixtures(date));
    if (!fixtures || !Array.isArray(fixtures) || fixtures.length === 0) {
      resetRateLimiter();
      try {
        const result = await getFixtures(date, { forceApi: true });
        fixtures = result.fixtures || [];
        if (fixtures.length > 0) {
          await redisSet(KEYS.fixtures(date), fixtures, 48 * 3600).catch(() => {});
        }
      } catch (e) {
        return Response.json({ error: `Failed to load fixtures: ${e.message}` }, { status: 500 });
      }
    }

    if (!fixtures || fixtures.length === 0) {
      return Response.json({ started: false, message: 'No fixtures for this date' });
    }

    // Initialize progress in Redis
    const progress = {
      running: true, completed: false,
      date, total: fixtures.length,
      offset: 0, analyzed: 0, skipped: 0, failed: 0,
      startedAt: new Date().toISOString(),
    };
    await redisSet(`reanalyze-progress:${date}`, progress, PROGRESS_TTL);

    // Fire first internal batch (fire-and-forget — browser can close)
    fetch(`${getBaseUrl()}/api/admin/reanalyze?date=${date}&offset=0`, {
      method: 'POST',
      headers: { 'x-internal-trigger': 'true' },
    }).catch(e => console.error('[reanalyze] Failed to start chain:', e.message));

    return Response.json({ started: true, total: fixtures.length });
  }

  // ── Internal batch processing ──────────────────────────────────────────────
  const allFixtures = await redisGet(KEYS.fixtures(date));
  if (!Array.isArray(allFixtures) || allFixtures.length === 0) {
    await redisSet(`reanalyze-progress:${date}`, {
      running: false, completed: false, error: 'Fixtures not in cache',
    }, PROGRESS_TTL);
    return Response.json({ error: 'Fixtures not in cache' }, { status: 400 });
  }

  const total = allFixtures.length;
  const batch = allFixtures.slice(offset, offset + BATCH_SIZE);

  if (batch.length === 0) {
    // Reached the end
    await _finalize(date, total, allFixtures);
    return Response.json({ success: true, message: 'All batches complete' });
  }

  // Load current progress counters
  const prog = await redisGet(`reanalyze-progress:${date}`) || {
    running: true, completed: false, date, total, offset,
    analyzed: 0, skipped: 0, failed: 0,
  };

  // Load accumulated analysis summary
  const existing     = await redisGet(`analysis:${date}`) || { globallyAnalyzed: [], analyzedOdds: {}, analyzedData: {} };
  const analyzedIds  = existing.globallyAnalyzed || [];
  const analyzedOdds = existing.analyzedOdds || {};
  const analyzedData = existing.analyzedData || {};
  const analyzedSet  = new Set(analyzedIds);

  let batchAnalyzed = 0, batchSkipped = 0, batchFailed = 0;

  for (const fixture of batch) {
    const fid    = fixture.fixture?.id;
    const status = fixture.fixture?.status?.short;

    // Skip finished matches — partido terminado, no se puede apostar
    if (FINISHED_STATUSES.has(status)) { batchSkipped++; continue; }

    // Skip live matches — partido en curso, no se puede apostar
    if (LIVE_STATUSES.has(status)) { batchSkipped++; continue; }

    // Skip already-analyzed NS matches (verify per-fixture cache exists)
    if (analyzedSet.has(fid)) {
      const cached = await getCachedAnalysis(fid, date, { strict: true });
      if (cached) { batchSkipped++; continue; }
      // Cache expired — fall through and re-analyze
    }

    // Analyze (up to 3 attempts)
    let result = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await analyzeMatch(fixture, { date });
        break;
      } catch (e) {
        console.warn(`[reanalyze] Attempt ${attempt + 1} failed for ${fid}: ${e.message}`);
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }

    if (result) {
      const a = result.analysis || result;
      if (result.fromCache) batchSkipped++;
      else batchAnalyzed++;
      analyzedIds.push(fid);
      analyzedSet.add(fid);
      if (a.odds?.matchWinner) analyzedOdds[fid] = a.odds.matchWinner;
      analyzedData[fid] = buildSummary(a);
    } else {
      batchFailed++;
      console.error(`[reanalyze] All attempts failed for fixture ${fid}`);
    }
  }

  // Persist accumulated analysis summary
  await redisSet(`analysis:${date}`, { globallyAnalyzed: analyzedIds, analyzedOdds, analyzedData }, 12 * 3600).catch(() => {});

  // Update progress counters
  const nextOffset   = offset + BATCH_SIZE;
  const hasMore      = nextOffset < total;
  const newAnalyzed  = (prog.analyzed || 0) + batchAnalyzed;
  const newSkipped   = (prog.skipped  || 0) + batchSkipped;
  const newFailed    = (prog.failed   || 0) + batchFailed;

  const updatedProg = {
    ...prog,
    offset: nextOffset,
    analyzed: newAnalyzed,
    skipped:  newSkipped,
    failed:   newFailed,
    running:  hasMore,
    completed: !hasMore,
    ...(hasMore ? {} : { completedAt: new Date().toISOString() }),
  };
  await redisSet(`reanalyze-progress:${date}`, updatedProg, PROGRESS_TTL);

  if (!hasMore) {
    await _finalize(date, total, allFixtures);
    return Response.json({ success: true, ...updatedProg });
  }

  // Chain next batch (fire-and-forget — this function returns immediately)
  fetch(`${getBaseUrl()}/api/admin/reanalyze?date=${date}&offset=${nextOffset}`, {
    method: 'POST',
    headers: { 'x-internal-trigger': 'true' },
  }).catch(e => console.error(`[reanalyze] Chain to offset ${nextOffset} failed:`, e.message));

  return Response.json({ success: true, ...updatedProg });
}

// ─── finalize: update live stats for finished matches + mark dailyBatch done ──

async function _finalize(date, total, allFixtures) {
  const FINISHED = ['FT', 'AET', 'PEN'];
  const finishedFixtures = allFixtures.filter(f => FINISHED.includes(f.fixture?.status?.short));

  if (finishedFixtures.length > 0) {
    const liveStatsMap = {};
    await Promise.all(finishedFixtures.map(async (f) => {
      const fid = f.fixture.id;
      const existing = await redisGet(KEYS.fixtureStats(fid));
      if (existing?.corners?.total > 0 || existing?.goalScorers?.length > 0) return;
      try {
        const stats = await fetchMatchStats(fid);
        if (stats) {
          await redisSet(KEYS.fixtureStats(fid), stats, TTL.yesterday);
          liveStatsMap[fid] = stats;
          supabaseAdmin.from('match_analysis')
            .update({ live_stats: stats })
            .eq('fixture_id', fid)
            .catch(() => {});
        }
      } catch {}
    }));

    if (Object.keys(liveStatsMap).length > 0) {
      const existingLive = await redisGet(KEYS.liveStats(date)) || {};
      const updatedLive  = { ...existingLive };
      for (const [fid, stats] of Object.entries(liveStatsMap)) {
        const f = allFixtures.find(x => x.fixture?.id === Number(fid));
        updatedLive[fid] = { ...stats, status: f?.fixture?.status, goals: f?.goals, score: f?.score };
      }
      await redisSet(KEYS.liveStats(date), updatedLive, TTL.yesterday).catch(() => {});
    }
  }

  // Mark daily batch completed so Phase 4 of /api/fixtures doesn't re-trigger
  await redisSet(`dailyBatch:${date}`, {
    completed: true, fixtureCount: total,
    completedAt: new Date().toISOString(), source: 'manual-reanalyze',
  }, 86400).catch(() => {});
}
