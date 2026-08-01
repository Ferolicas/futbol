import { enqueue } from '../../../../../lib/worker-client';
import { getMultisportConfig, isIsoDate } from '../../../../../lib/multisport-config';
import { getCurrentUser } from '../../../../../lib/auth-pg';
import { userHasActivePlan } from '../../../../../lib/require-active-plan';
import { jsonError } from '../../../../../lib/api-error';

export const dynamic = 'force-dynamic';

export async function POST(request, { params }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!(await userHasActivePlan(user))) return Response.json({ error: 'Subscription required' }, { status: 403 });
    const config = getMultisportConfig(params.sport);
    if (!['basketball', 'american_football'].includes(config.key)) return Response.json({ error: 'Unsupported route' }, { status: 400 });
    const body = await request.json().catch(() => ({}));
    const date = body.date || new Date().toISOString().slice(0, 10);
    if (!isIsoDate(date)) return Response.json({ error: 'Invalid date' }, { status: 400 });
    const queue = config.key === 'basketball' ? 'basketball-analyze' : 'american-football-analyze';
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    const result = await enqueue(queue, { date, force: body.force === true }, {
      name: `${queue}-manual-${date}`,
      jobOpts: { jobId: `${queue}-manual-${date}-${hourBucket}` },
    });
    return Response.json(result, { status: result.ok === false ? 503 : 202 });
  } catch (error) {
    console.error('[api/sports/analyze]', error.message);
    return jsonError(error);
  }
}
