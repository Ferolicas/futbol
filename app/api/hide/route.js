import { hideMatch, unhideMatch, getHiddenMatches } from '../../../lib/football-api';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const hidden = await getHiddenMatches();
    return Response.json({ hidden });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { fixtureId, action } = await request.json();

    if (!fixtureId) {
      return Response.json({ error: 'fixtureId required' }, { status: 400 });
    }

    let hidden;
    if (action === 'unhide') {
      hidden = await unhideMatch(Number(fixtureId));
    } else {
      hidden = await hideMatch(Number(fixtureId));
    }

    return Response.json({ hidden });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
