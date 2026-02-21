import { getQuota } from '../../../lib/football-api';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const quota = await getQuota();
    return Response.json(quota);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
