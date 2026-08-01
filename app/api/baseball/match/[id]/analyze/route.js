/** Reanálisis de un juego MLB con el motor empírico. */
import { analyzeSportGame } from '../../../../../../lib/multisport-analysis';
import { getSportGamesByDate } from '../../../../../../lib/multisport-providers';
import { getCurrentUser } from '../../../../../../lib/auth-pg';
import { userHasActivePlan } from '../../../../../../lib/require-active-plan';
import { jsonError } from '../../../../../../lib/api-error';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(_request, { params }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!(await userHasActivePlan(user))) return Response.json({ error: 'Subscription required' }, { status: 403 });
    const fixtureId = String(params.id || '');
    if (!/^\d+$/.test(fixtureId)) return Response.json({ error: 'Invalid id' }, { status: 400 });
    const today = new Date().toISOString().slice(0, 10);
    const games = [];
    for (const offset of [-1, 0, 1]) {
      const value = new Date(`${today}T12:00:00Z`);
      value.setUTCDate(value.getUTCDate() + offset);
      games.push(...await getSportGamesByDate('baseball', value.toISOString().slice(0, 10)).catch(() => []));
    }
    const game = games.find((item) => String(item.id) === fixtureId);
    if (!game) return Response.json({ error: 'Game not found in MLB Stats API (±1 day)' }, { status: 404 });
    const result = await analyzeSportGame('baseball', game, { oddsTtl: 6 * 3600 });
    return Response.json({ success: true, fixtureId: Number(fixtureId), probabilities: result.probabilities, combinada: result.combinada, dataQuality: result.dataQuality });
  } catch (error) {
    console.error('[api/baseball/match/analyze]', error.message);
    return jsonError(error);
  }
}
