/**
 * POST /api/cron/analyze-all-today
 * Fetches today's fixtures fresh from API-Football and analyzes ALL of them.
 * Saves analysis to Supabase match_analysis + Redis.
 * Requires CRON_SECRET header.
 */
import { getFixtures, analyzeMatch, getQuota } from '../../../../lib/api-football';
import { cacheAnalysis, getAnalyzedFixtureIds } from '../../../../lib/sanity-cache';
import { redisSet, KEYS } from '../../../../lib/redis';

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

    for (let i = 0; i < toAnalyze.length; i += BATCH_SIZE) {
      const batch = toAnalyze.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (fixture) => {
          try {
            const result = await analyzeMatch(fixture, { date });
            if (!result || result.dataQuality === 'insufficient') {
              results.skipped++;
              return { fixtureId: fixture.fixture.id, skipped: true };
            }
            await cacheAnalysis(fixture.fixture.id, { ...result, date });
            results.success++;
            return { fixtureId: fixture.fixture.id, success: true };
          } catch (e) {
            console.error(`[analyze-all-today] fixture ${fixture.fixture.id}:`, e.message);
            results.failed++;
            results.errors.push({ fixtureId: fixture.fixture.id, error: e.message });
            return { fixtureId: fixture.fixture.id, error: e.message };
          }
        })
      );

      // Small delay between batches to be respectful of API limits
      if (i + BATCH_SIZE < toAnalyze.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // 4. Invalidate Redis analysis cache so next fixtures request reads fresh data
    await redisSet(`analysis:${date}`, null, 1).catch(() => {});

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
