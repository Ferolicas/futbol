import { analyzeMatch, getQuota } from '../../../lib/api-football';
import { cacheAnalysis } from '../../../lib/sanity-cache';
import { redisGet, redisSet } from '../../../lib/redis';
import { createSupabaseServerClient } from '../../../lib/supabase-auth';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const supabase = createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id || null;

    const { fixtures, date: clientDate } = await request.json();

    if (!fixtures || !Array.isArray(fixtures) || fixtures.length === 0) {
      return Response.json({ error: 'fixtures array required' }, { status: 400 });
    }

    const date = clientDate || new Date().toISOString().split('T')[0];
    const toAnalyze = fixtures.slice(0, 5);
    let totalApiCalls = 0;

    const analyses = await Promise.all(
      toAnalyze.map(async (fixture) => {
        try {
          const result = await analyzeMatch(fixture, { date });
          totalApiCalls += result.apiCalls || 0;
          await cacheAnalysis(fixture.fixture.id, { ...result, date }).catch(() => {});
          return { fixtureId: fixture.fixture.id, success: true, ...result };
        } catch (e) {
          return { fixtureId: fixture.fixture.id, success: false, error: e.message };
        }
      })
    );

    // Update the analysis:${date} summary so loadFixtures reflects the new analyses.
    // Without this, the summary key still shows the old count and overwrites the
    // optimistic UI update when the dashboard re-fetches.
    const successful = analyses.filter(a => a.success);
    if (successful.length > 0) {
      try {
        const existing = await redisGet(`analysis:${date}`) || { globallyAnalyzed: [], analyzedOdds: {}, analyzedData: {} };
        const analyzedIds  = existing.globallyAnalyzed || [];
        const analyzedOdds = existing.analyzedOdds     || {};
        const analyzedData = existing.analyzedData     || {};

        for (const a of successful) {
          const analysis = a.analysis || a;
          const fid = a.fixtureId;
          if (!analyzedIds.includes(fid)) analyzedIds.push(fid);
          if (analysis?.odds?.matchWinner) analyzedOdds[fid] = analysis.odds.matchWinner;

          // Compact summary (same shape as analyze-batch buildSummary)
          const e = analysis;
          if (e?.homeTeam) {
            analyzedData[fid] = {
              fixtureId:              e.fixtureId,
              homeTeam:               e.homeTeam,   awayTeam:  e.awayTeam,
              homeLogo:               e.homeLogo,   awayLogo:  e.awayLogo,
              homeId:                 e.homeId,     awayId:    e.awayId,
              league:                 e.league,     leagueId:  e.leagueId,
              leagueLogo:             e.leagueLogo,
              kickoff:                e.kickoff,    status:    e.status,
              goals:                  e.goals,      odds:      e.odds,
              combinada:              e.combinada,
              calculatedProbabilities: e.calculatedProbabilities,
              homePosition:           e.homePosition, awayPosition: e.awayPosition,
              homeLastFive:           (e.homeLastFive || []).map(m => {
                const en = m._enriched || {};
                return { r: en.result, s: en.score, gF: en.goalsFor, gA: en.goalsAgainst, op: en.opponentName, oL: en.opponentLogo, c: en.corners, y: en.yellowCards, rd: en.redCards };
              }),
              awayLastFive:           (e.awayLastFive || []).map(m => {
                const en = m._enriched || {};
                return { r: en.result, s: en.score, gF: en.goalsFor, gA: en.goalsAgainst, op: en.opponentName, oL: en.opponentLogo, c: en.corners, y: en.yellowCards, rd: en.redCards };
              }),
              playerHighlights:       e.playerHighlights || null,
            };
          }
        }

        await redisSet(`analysis:${date}`, { globallyAnalyzed: analyzedIds, analyzedOdds, analyzedData }, 12 * 3600);
      } catch (e) {
        console.error('[analisis] summary update failed:', e.message);
      }
    }

    const quota = await getQuota();
    return Response.json({ analyses, totalApiCalls, quota });
  } catch (error) {
    console.error('[analisis]', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
