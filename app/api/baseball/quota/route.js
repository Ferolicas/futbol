/** Cuota independiente de API-Baseball; MLB Stats no consume cupo. */
import { getApiSportsQuota } from '../../../../lib/api-sports-multisport';
import { getCurrentUser } from '../../../../lib/auth-pg';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!(await getCurrentUser())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const quota = await getApiSportsQuota('baseball');
  return Response.json({ used: quota.used, limit: quota.budget, remaining: quota.remaining, date: quota.date, source: 'api-baseball-odds' });
}
