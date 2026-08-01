import { pgPool } from '../../../../../../lib/db';
import { getMultisportConfig } from '../../../../../../lib/multisport-config';
import { getCurrentUser } from '../../../../../../lib/auth-pg';
import { userHasActivePlan } from '../../../../../../lib/require-active-plan';
import { jsonError } from '../../../../../../lib/api-error';

export const dynamic = 'force-dynamic';

export async function GET(_request, { params }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!(await userHasActivePlan(user))) return Response.json({ error: 'Subscription required' }, { status: 403 });
    const config = getMultisportConfig(params.sport);
    if (config.key === 'baseball') return Response.json({ error: 'Use /api/baseball/match' }, { status: 400 });
    const table = `${config.tablePrefix}_match_analysis`;
    const matches = `${config.tablePrefix}_engine_matches`;
    const [analysis, match] = await Promise.all([
      pgPool.query(`SELECT * FROM ${table} WHERE fixture_id=$1`, [String(params.id)]),
      pgPool.query(
        `SELECT fixture_id,provider,provider_fixture_id,competition_id,season,kickoff,status,
                home_team_id,away_team_id,home_team,away_team,home_logo,away_logo,
                home_score,away_score,periods,finalized_at,updated_at
         FROM ${matches} WHERE fixture_id=$1`,
        [String(params.id)],
      ),
    ]);
    if (!analysis.rows[0]) return Response.json({ error: 'Not analyzed yet' }, { status: 404 });
    return Response.json({ success: true, analysis: analysis.rows[0], match: match.rows[0] || null });
  } catch (error) {
    console.error('[api/sports/match]', error.message);
    return jsonError(error);
  }
}
