import { getQuota } from '../../../lib/api-football';

export const dynamic = 'force-dynamic';

// Lightweight endpoint for quota polling — NO API-Football calls
export async function GET() {
  try {
    const quota = await getQuota();
    return Response.json({ quota }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (e) {
    return Response.json({ quota: { used: 0, remaining: 7500, limit: 7500 } });
  }
}
