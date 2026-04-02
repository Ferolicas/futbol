/**
 * POST /api/cron/analyze-all-today
 * Fetches today's fixtures fresh from API-Football and analyzes ALL of them.
 * Saves analysis to Supabase match_analysis + Redis.
 * Requires CRON_SECRET header.
 */
import { getFixtures, analyzeMatch, getQuota } from '../../../../lib/api-football';
import { getAnalyzedFixtureIds } from '../../../../lib/sanity-cache';
import { redisSet, KEYS } from '../../../../lib/redis';

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

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 min Vercel timeout

export async function POST(request) {
  const secret = request.headers.get('x-cron-secret') || request.headers.get('authorization')?.replace('Bearer ', '');
  if (secret !== process.env.CRON_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const forceAll = searchParams.get('force') === 'true';

  console.log(`[analyze-all-today] Starting for date=${date} force=${forceAll}`);
  const startTime = Date.now();

  try {
    // 1. Fetch fresh fixtures from API-Football
    const { fixtures } = await getFixtures(date, { forceApi: forceAll });
    const allFixtures = fixtures || [];

    if (allFixtures.length === 0) {
      return Response.json({ success: true, message: 'No fixtures for this date', analyzed: 0 });
    }

    // 2. Get already-analyzed fixture IDs (skip unless force=true)
    const alreadyAnalyzed = forceAll ? [] : await getAnalyzedFixtureIds(date);
    const toAnalyze = forceAll
      ? allFixtures
      : allFixtures.filter(f => !alreadyAnalyzed.includes(f.fixture.id));

    console.log(`[analyze-all-today] ${allFixtures.length} fixtures, ${toAnalyze.length} to analyze`);

    if (toAnalyze.length === 0) {
      return Response.json({ success: true, message: 'All fixtures already analyzed', analyzed: 0, total: allFixtures.length });
    }

    // 3. Analyze in batches of 3 (parallel per batch to avoid API rate limits)
    const BATCH_SIZE = 3;
    const results = { success: 0, failed: 0, skipped: 0, errors: [] };
    const analyzedIds = [];
    const analyzedOdds = {};
    const analyzedData = {};

    for (let i = 0; i < toAnalyze.length; i += BATCH_SIZE) {
      const batch = toAnalyze.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (fixture) => {
          const fid = fixture.fixture.id;
          try {
            const result = await analyzeMatch(fixture, { date });
            if (!result || result.dataQuality === 'insufficient') {
              results.skipped++;
              return;
            }
            // analyzeMatch already calls cacheAnalysis internally — do NOT call again
            results.success++;
            const a = result.analysis || result;
            analyzedIds.push(fid);
            if (a?.odds?.matchWinner) analyzedOdds[fid] = a.odds.matchWinner;
            const summary = buildSummary(a);
            if (summary) analyzedData[fid] = summary;
          } catch (e) {
            console.error(`[analyze-all-today] fixture ${fid}:`, e.message);
            results.failed++;
            results.errors.push({ fixtureId: fid, error: e.message });
          }
        })
      );

      // Small delay between batches to be respectful of API limits
      if (i + BATCH_SIZE < toAnalyze.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // 4. Write fresh analysis summary cache
    if (analyzedIds.length > 0) {
      await redisSet(`analysis:${date}`, { globallyAnalyzed: analyzedIds, analyzedOdds, analyzedData }, 12 * 3600).catch(() => {});
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const quota = await getQuota();

    console.log(`[analyze-all-today] Done in ${duration}s — success:${results.success} failed:${results.failed} skipped:${results.skipped}`);

    return Response.json({
      success: true,
      date,
      total: allFixtures.length,
      analyzed: results.success,
      failed: results.failed,
      skipped: results.skipped,
      duration: `${duration}s`,
      quota,
      errors: results.errors.slice(0, 5),
    });

  } catch (e) {
    console.error('[analyze-all-today]', e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// Also allow GET for manual browser trigger (with secret in query param)
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret');
  const modifiedRequest = new Request(request.url, {
    method: 'POST',
    headers: { ...Object.fromEntries(request.headers), 'x-cron-secret': secret || '' },
  });
  return POST(modifiedRequest);
}
