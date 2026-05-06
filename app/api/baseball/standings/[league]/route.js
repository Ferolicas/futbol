import { getBaseballStandings } from '../../../../../lib/api-baseball';

export const dynamic = 'force-dynamic';

export async function GET(_request, { params }) {
  try {
    const leagueId = Number(params.league);
    if (!leagueId) return Response.json({ error: 'Invalid league id' }, { status: 400 });
    const { standings, fromCache } = await getBaseballStandings(leagueId);
    return Response.json({ leagueId, standings, fromCache });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
