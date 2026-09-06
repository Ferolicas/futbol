import { getCurrentUser } from '../../../../lib/auth-pg';
import { userHasActivePlan } from '../../../../lib/require-active-plan';
import { pgPool } from '../../../../lib/db';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (await userHasActivePlan(user)) return Response.json({ paid: true, showPlans: false });
  const { visitId } = await request.json().catch(() => ({}));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(visitId || '')) return Response.json({ error: 'Invalid visit' }, { status: 400 });
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`free-visit:${user.id}`]);
    const previous = await client.query('SELECT visit_number FROM free_app_visits WHERE user_id=$1 AND visit_id=$2', [user.id, visitId]);
    let number = previous.rows[0]?.visit_number;
    if (!number) {
      const result = await client.query('INSERT INTO free_app_visits (user_id, visit_id, visit_number) SELECT $1,$2,COALESCE(MAX(visit_number),0)+1 FROM free_app_visits WHERE user_id=$1 RETURNING visit_number', [user.id, visitId]);
      number = result.rows[0].visit_number;
    }
    await client.query('COMMIT');
    return Response.json({ paid: false, showPlans: (number - 1) % 3 === 0, visitNumber: number }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[free/visit]', error.message);
    return Response.json({ error: 'No se pudo registrar la visita' }, { status: 503 });
  } finally { client.release(); }
}
