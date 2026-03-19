import { auth, currentUser } from '@clerk/nextjs/server';
import { analyzeMatch } from '../../../../lib/api-football';
import { getCachedFixturesRaw } from '../../../../lib/sanity-cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const OWNER_EMAIL = 'ferneyolicas@gmail.com';

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress?.toLowerCase();
  if (email !== OWNER_EMAIL) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const fixtures = await getCachedFixturesRaw(today);

    if (!fixtures || fixtures.length === 0) {
      return Response.json({ success: true, analyzed: 0, message: 'No fixtures for today' });
    }

    let analyzed = 0;
    let failed = 0;

    // Process in batches of 5 to avoid overwhelming the API
    for (let i = 0; i < fixtures.length; i += 5) {
      const batch = fixtures.slice(i, i + 5);
      await Promise.all(
        batch.map(async (fixture) => {
          try {
            await analyzeMatch(fixture, { date: today, force: true });
            analyzed++;
          } catch (e) {
            failed++;
            console.error(`[REANALYZE] Failed ${fixture.fixture?.id}:`, e.message);
          }
        })
      );
    }

    return Response.json({
      success: true,
      analyzed,
      failed,
      total: fixtures.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[REANALYZE] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
