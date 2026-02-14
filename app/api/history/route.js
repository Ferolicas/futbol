import { getAnalyzedMatches, getAllAnalyzedDates } from '../../../lib/football-api';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date');

  try {
    if (date) {
      // Get analyzed matches for a specific date
      const analyses = await getAnalyzedMatches(date);
      return Response.json({ analyses, date });
    } else {
      // Get all dates that have analyzed matches
      const dates = await getAllAnalyzedDates();
      return Response.json({ dates });
    }
  } catch (error) {
    console.error('History error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
