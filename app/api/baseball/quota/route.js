import { getBaseballQuota } from '../../../../lib/api-baseball';

export const dynamic = 'force-dynamic';

export async function GET() {
  const quota = await getBaseballQuota();
  return Response.json(quota);
}
