// @ts-nocheck
/**
 * Job: futbol-analyze-batch
 *
 * Analyzes every fixture for `date`. Uses a worker-pool (mapPool) so we
 * always keep ANALYZE_CONCURRENCY matches in flight; the shared rate
 * limiter inside lib/api-football.js (~9 req/s) is the real ceiling, not
 * batch alignment.
 *
 * Idempotent on retry: analyzeMatch returns `fromCache=true` for fixtures
 * already in Supabase, so re-runs are nearly free for the already-done
 * ones and only re-attempt the failures.
 *
 * If any fixture still has no analysis at the end, the job throws — BullMQ
 * retries with exponential backoff (see attempts in queues.ts). That
 * guarantees no match is silently dropped because the process died or
 * because the API hiccupped on one call.
 *
 * Payload: { date: 'YYYY-MM-DD' }
 */
import { analyzeMatch, getCachedFixturesRaw, redisGet, redisSet, triggerEvent } from '../../shared.js';
import { mapPool } from '../../pool.js';

const ANALYZE_CONCURRENCY = 25;
const PERSIST_EVERY = 5;

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
  if (!a) return null;
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

async function markComplete(date, fixtureCount) {
  try {
    await redisSet(`dailyBatch:${date}`, {
      date, completed: true, fixtureCount,
      completedAt: new Date().toISOString(),
    }, 86400);
  } catch (e) {
    console.error('[job:futbol-analyze-batch] markComplete redis:', e.message);
  }
  try {
    await triggerEvent('analysis', 'batch-complete', {
      date, fixtureCount, timestamp: new Date().toISOString(),
    });
  } catch {}
}

export async function runAnalyzeBatch(payload = {}) {
  const { date } = payload;
  if (!date) throw new Error('analyze-batch: date is required');
  const startedAt = Date.now();

  const allFixtures = await getCachedFixturesRaw(date);
  if (!allFixtures || allFixtures.length === 0) {
    return { ok: true, message: 'no fixtures in cache', date };
  }

  const existing     = (await redisGet(`analysis:${date}`)) || { globallyAnalyzed: [], analyzedOdds: {}, analyzedData: {} };
  const analyzedIds  = new Set((existing.globallyAnalyzed || []).map(Number));
  const analyzedOdds = { ...(existing.analyzedOdds || {}) };
  const analyzedData = { ...(existing.analyzedData || {}) };

  let analyzed = 0, cached = 0, processed = 0;
  const failedFids = [];
  let persistInFlight = null;

  // Debounced persistence: at most one Redis write in flight at a time,
  // each one captures a fresh snapshot. Race-safe because the body is
  // single-threaded; the worst case is a slightly-stale snapshot.
  const schedulePersist = () => {
    if (persistInFlight) return;
    persistInFlight = redisSet(`analysis:${date}`, {
      globallyAnalyzed: [...analyzedIds],
      analyzedOdds,
      analyzedData,
    }, 12 * 3600)
      .catch(e => console.error('[job:futbol-analyze-batch] persist:', e.message))
      .finally(() => { persistInFlight = null; });
  };

  const results = await mapPool(allFixtures, ANALYZE_CONCURRENCY, async (fixture) => {
    const fid = Number(fixture.fixture.id);
    const result = await analyzeMatch(fixture, { date });
    if (!result) return { fid, skipped: true };

    const a = result.analysis || result;
    if (result.fromCache) cached++; else analyzed++;
    analyzedIds.add(fid);
    if (a?.odds?.matchWinner) analyzedOdds[fid] = a.odds.matchWinner;
    const summary = buildSummary(a);
    if (summary) analyzedData[fid] = summary;

    processed++;
    if (processed % PERSIST_EVERY === 0) schedulePersist();
    return { fid, skipped: false };
  });

  // Collect failures (don't lose track of which fixtures didn't make it)
  results.forEach((r, idx) => {
    if (!r.ok) {
      const fid = Number(allFixtures[idx].fixture.id);
      failedFids.push(fid);
      console.error(`[job:futbol-analyze-batch] failed ${fid}:`, r.error.message);
    }
  });

  // Final persistence (await any in-flight write first, then one more snapshot)
  if (persistInFlight) await persistInFlight.catch(() => {});
  try {
    await redisSet(`analysis:${date}`, {
      globallyAnalyzed: [...analyzedIds],
      analyzedOdds,
      analyzedData,
    }, 12 * 3600);
  } catch (e) {
    console.error('[job:futbol-analyze-batch] final persist:', e.message);
  }

  try {
    await triggerEvent('analysis', 'batch-progress', {
      date,
      progress: `${analyzedIds.size}/${allFixtures.length}`,
      analyzed, cached, failed: failedFids.length,
    });
  } catch {}

  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  // If ANY fixture failed, throw — BullMQ will retry with backoff. On retry,
  // analyzeMatch returns fromCache=true for completed ones so we only re-do
  // the failures.
  if (failedFids.length > 0) {
    console.error(
      `[job:futbol-analyze-batch] ${failedFids.length}/${allFixtures.length} fixtures failed in ${durationSec}s — throwing for BullMQ retry`,
    );
    throw new Error(`analyze-batch incomplete: ${failedFids.length} failures (${failedFids.slice(0, 10).join(',')}${failedFids.length > 10 ? '…' : ''})`);
  }

  await markComplete(date, allFixtures.length);

  return {
    ok: true,
    date,
    total: allFixtures.length,
    analyzed,
    cached,
    failed: 0,
    durationSec: Number(durationSec),
    concurrency: ANALYZE_CONCURRENCY,
  };
}
