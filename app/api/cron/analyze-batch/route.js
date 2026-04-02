/**
 * POST /api/cron/analyze-batch
 * Internal batch processor: analyzes a slice of fixtures and chains to the next batch.
 * Called internally by /api/cron/daily. NOT for direct use.
 */
import { analyzeMatch } from '../../../../lib/api-football';
import { getCachedFixturesRaw } from '../../../../lib/sanity-cache';
import { redisSet } from '../../../../lib/redis';
import { triggerEvent } from '../../../../lib/pusher';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request) {
  const isInternal = request.headers.get('x-internal-trigger') === 'true';
  if (!isInternal && process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { offset, batchSize, date, totalFixtures } = await request.json();

    const allFixtures = await getCachedFixturesRaw(date);
    if (!allFixtures || allFixtures.length === 0) {
      return Response.json({ success: true, message: 'No fixtures in cache' });
    }

    const batch = allFixtures.slice(offset, offset + batchSize);
    if (batch.length === 0) {
      // All done — mark complete in Redis
      await redisSet(`dailyBatch:${date}`, {
        date, completed: true,
        fixtureCount: totalFixtures || allFixtures.length,
        completedAt: new Date().toISOString(),
      }, 86400);
      console.log(`[ANALYZE-BATCH] All done for ${date}`);
      await triggerEvent('analysis', 'batch-complete', {
        date, fixtureCount: totalFixtures || allFixtures.length, timestamp: new Date().toISOString(),
      });
      return Response.json({ success: true, message: 'All batches complete' });
    }

    console.log(`[ANALYZE-BATCH] Processing ${batch.length} matches (offset ${offset}/${allFixtures.length})`);

    let analyzed = 0, cached = 0, failed = 0;

    await Promise.all(batch.map(async (fixture) => {
      try {
        const result = await analyzeMatch(fixture, { date });
        if (result) {
          // analyzeMatch already calls cacheAnalysis internally — do NOT call again
          if (result.fromCache) cached++; else analyzed++;
        }
      } catch (e) {
        failed++;
        console.error(`[ANALYZE-BATCH] Failed ${fixture.fixture.id}:`, e.message);
      }
    }));

    await triggerEvent('analysis', 'batch-progress', {
      date,
      progress: `${Math.min(offset + batchSize, allFixtures.length)}/${allFixtures.length}`,
      analyzed, cached, failed,
    });

    const nextOffset = offset + batchSize;
    const hasMore = nextOffset < allFixtures.length;

    if (hasMore) {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL
        || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

      fetch(`${baseUrl}/api/cron/analyze-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-trigger': 'true' },
        body: JSON.stringify({ offset: nextOffset, batchSize, date, totalFixtures: allFixtures.length }),
      }).catch(() => {});
    } else {
      await redisSet(`dailyBatch:${date}`, {
        date, completed: true,
        fixtureCount: allFixtures.length,
        completedAt: new Date().toISOString(),
      }, 86400);
      console.log(`[ANALYZE-BATCH] All batches complete for ${date}`);
      await triggerEvent('analysis', 'batch-complete', {
        date, fixtureCount: allFixtures.length, timestamp: new Date().toISOString(),
      });
    }

    return Response.json({
      success: true, analyzed, cached, failed, hasMore,
      progress: `${Math.min(nextOffset, allFixtures.length)}/${allFixtures.length}`,
    });
  } catch (error) {
    console.error('[ANALYZE-BATCH] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
