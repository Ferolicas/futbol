import { queryFromSanity } from '../../../lib/sanity';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || new Date().toISOString().split('T')[0];

  try {
    // Read persisted live stats from Sanity
    const liveStats = await queryFromSanity(
      `*[_type == "liveMatchStats" && date == $date]{
        fixtureId, status, goals, score, corners, yellowCards, redCards,
        goalScorers, cardEvents, missedPenalties, homeTeam, awayTeam, updatedAt
      }`,
      { date }
    );

    return Response.json({
      liveStats: liveStats || [],
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({ liveStats: [], error: error.message });
  }
}
