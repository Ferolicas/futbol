import { analyzeMatch } from '../../../../lib/api-football';
import { getFromSanity, saveToSanity } from '../../../../lib/sanity';
import { getCachedFixturesRaw } from '../../../../lib/sanity-cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Processes a batch of matches and chains to the next batch
export async function POST(request) {
  const isInternal = request.headers.get('x-internal-trigger') === 'true';
  if (!isInternal && process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { offset, batchSize, date, totalFixtures } = await request.json();

    // Load fixtures from cache (already cached by daily endpoint)
    const allFixtures = await getCachedFixturesRaw(date);
    if (!allFixtures || allFixtures.length === 0) {
      return Response.json({ success: true, message: 'No fixtures in cache' });
    }

    const batch = allFixtures.slice(offset, offset + batchSize);
    if (batch.length === 0) {
      // All done — mark complete
      await saveToSanity('appConfig', `dailyBatch-${date}`, {
        date,
        started: true,
        completed: true,
        fixtureCount: totalFixtures || allFixtures.length,
        completedAt: new Date().toISOString(),
      });
      console.log(`[ANALYZE-BATCH] All done for ${date}`);
      return Response.json({ success: true, message: 'All batches complete' });
    }

    console.log(`[ANALYZE-BATCH] Processing ${batch.length} matches (offset ${offset}/${allFixtures.length})`);

    let analyzed = 0;
    let cached = 0;
    let failed = 0;

    // Analyze batch in parallel
    await Promise.all(
      batch.map(async (fixture) => {
        try {
          const result = await analyzeMatch(fixture);
          if (result.fromCache) cached++;
          else analyzed++;
        } catch (e) {
          failed++;
          console.error(`[ANALYZE-BATCH] Failed ${fixture.fixture.id}:`, e.message);
        }
      })
    );

    // Chain to next batch (non-blocking)
    const nextOffset = offset + batchSize;
    const hasMore = nextOffset < allFixtures.length;

    if (hasMore) {
      const baseUrl = process.env.NEXTAUTH_URL || (process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'http://localhost:3000');

      fetch(`${baseUrl}/api/cron/analyze-batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-trigger': 'true',
        },
        body: JSON.stringify({
          offset: nextOffset,
          batchSize,
          date,
          totalFixtures: allFixtures.length,
        }),
      }).catch(() => {});
    } else {
      // Last batch — mark complete
      await saveToSanity('appConfig', `dailyBatch-${date}`, {
        date,
        started: true,
        completed: true,
        fixtureCount: allFixtures.length,
        completedAt: new Date().toISOString(),
      });
      console.log(`[ANALYZE-BATCH] All batches complete for ${date}`);
    }

    return Response.json({
      success: true,
      analyzed,
      cached,
      failed,
      hasMore,
      progress: `${Math.min(nextOffset, allFixtures.length)}/${allFixtures.length}`,
    });
  } catch (error) {
    console.error('[ANALYZE-BATCH] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
