/**
 * GET /api/baseball/quota
 *
 * MLB Stats API es gratuita y sin límite, así que el "cupo" relevante ya no es
 * el de api-sports baseball (purgado en la migración MLB-only). El cap real
 * ahora es el de The Odds API (450/mes ≈ 15/día) que comparte fútbol y baseball
 * para traer cuotas. Devolvemos ese contador para que el badge del dashboard
 * siga mostrando algo útil ("API X/15"), con el mismo shape que esperaba la
 * UI: { used, limit, remaining, date }.
 */
import { redisGet } from '../../../../lib/redis';
import { getCurrentUser } from '../../../../lib/auth-pg';

export const dynamic = 'force-dynamic';

const DAILY_REQUEST_CAP = 15;

export async function GET() {
  if (!(await getCurrentUser())) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const date = new Date().toISOString().split('T')[0];
  let used = 0;
  try { used = Number(await redisGet(`theodds:req:${date}`)) || 0; } catch {}
  return Response.json({
    used,
    limit: DAILY_REQUEST_CAP,
    remaining: Math.max(0, DAILY_REQUEST_CAP - used),
    date,
    source: 'the-odds-api',
  });
}
