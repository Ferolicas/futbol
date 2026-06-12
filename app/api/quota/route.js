import { getQuota } from '../../../lib/api-football';
import { getCurrentUser } from '../../../lib/auth-pg';

export const dynamic = 'force-dynamic';

// Lightweight endpoint for quota polling — NO API-Football calls
export async function GET() {
  try {
    if (!(await getCurrentUser())) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const quota = await getQuota();
    return Response.json({ quota }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (e) {
    return Response.json({ quota: { used: 0 } });
  }
}
