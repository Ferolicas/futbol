import { getFixtures, getQuota } from '../../../../lib/api-football';
import { saveToSanity } from '../../../../lib/sanity';

// Cron: runs at 10:00 AM Spain time (08:00 UTC in winter, 08:00 UTC in summer)
// This ensures all LATAM countries (Mexico UTC-6 = 4AM, Colombia UTC-5 = 5AM) have the correct date
// Vercel cron schedule: "0 8 * * *"

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request) {
  // Verify cron secret (Vercel sends this header)
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    console.log(`[CRON] Loading fixtures for ${today}...`);

    // Load all fixtures for today
    const result = await getFixtures(today);
    const fixtures = result.fixtures || [];

    // Also pre-load tomorrow's fixtures if API budget allows
    const quota = await getQuota();
    let tomorrowCount = 0;

    if (quota.remaining > 100) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowDate = tomorrow.toISOString().split('T')[0];

      try {
        const tResult = await getFixtures(tomorrowDate);
        tomorrowCount = tResult.fixtures?.length || 0;
      } catch (e) {
        console.error('[CRON] Tomorrow fetch failed:', e.message);
      }
    }

    const finalQuota = await getQuota();

    return Response.json({
      success: true,
      date: today,
      fixtureCount: fixtures.length,
      tomorrowCount,
      quota: finalQuota,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[CRON] Fixtures error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
