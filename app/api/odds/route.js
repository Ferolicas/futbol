import { queryFromSanity } from '../../../lib/sanity';
import { filterHighProbabilityBets } from '../../../lib/odds-api';

// Returns cached odds from The Odds API (stored by the cron job)
// No cache — always serves latest from Sanity

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const fixtureId = searchParams.get('fixtureId');

  try {
    let odds;

    if (fixtureId) {
      // Single fixture
      odds = await queryFromSanity(
        `*[_type == "oddsCache" && fixtureId == $fid][0]`,
        { fid: Number(fixtureId) }
      );
      if (!odds) {
        return Response.json({ odds: null, highProbBets: [] });
      }
      const highProbBets = filterHighProbabilityBets(odds.odds);
      return Response.json({ odds: odds.odds, highProbBets, fetchedAt: odds.fetchedAt });
    }

    // All fixtures for a date
    odds = await queryFromSanity(
      `*[_type == "oddsCache" && date == $date]{
        fixtureId, odds, fetchedAt
      }`,
      { date }
    );

    const result = {};
    for (const o of (odds || [])) {
      result[o.fixtureId] = {
        ...o.odds,
        highProbBets: filterHighProbabilityBets(o.odds),
        fetchedAt: o.fetchedAt,
      };
    }

    return Response.json({
      odds: result,
      count: Object.keys(result).length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({ odds: {}, error: error.message });
  }
}
