import { getBzzoiroLive, matchBzzoiroToFixtures, applyLiveUpdates } from '../../../lib/bzzoiro-api';
import { getFromSanity, saveToSanity } from '../../../lib/sanity';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date');
  const bzzoiroKey = process.env.BZZOIRO_API_KEY;

  if (!date) {
    return Response.json({ error: 'date parameter required' }, { status: 400 });
  }

  try {
    // Get current cached matches from Sanity
    const cached = await getFromSanity('matchDay', date);
    const fixtures = cached?.matches || [];

    if (fixtures.length === 0) {
      return Response.json({ matches: [], source: 'empty' });
    }

    // Use Bzzoiro for live scores (free, fast, unlimited)
    if (bzzoiroKey) {
      try {
        const liveData = await getBzzoiroLive(bzzoiroKey);
        const updates = matchBzzoiroToFixtures(liveData, fixtures);
        const updatedMatches = applyLiveUpdates(fixtures, updates);

        // Save updated scores to cache
        await saveToSanity('matchDay', date, {
          date,
          matches: updatedMatches,
          fetchedAt: new Date().toISOString(),
          matchCount: updatedMatches.length,
        });

        return Response.json({
          matches: updatedMatches,
          source: 'bzzoiro',
          liveUpdated: Object.keys(updates).length,
        });
      } catch (e) {
        console.error('Bzzoiro live error, returning cached:', e.message);
      }
    }

    // Fallback: return cached data as-is
    return Response.json({ matches: fixtures, source: 'cache' });
  } catch (error) {
    console.error('Live scores error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
