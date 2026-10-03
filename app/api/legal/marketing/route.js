import { getCurrentUser } from '../../../../lib/auth-pg';
import {
  currentMarketingPreference,
  prepareLegalEvidence,
  recordMarketingPreference,
} from '../../../../lib/legal';
import { redisRateLimit } from '../../../../lib/ratelimit-redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  return Response.json(await currentMarketingPreference(user.id));
}

export async function POST(request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const limit = await redisRateLimit('marketing-preference', user.id, 8, 60 * 60, { failClosed: true });
  if (!limit.success) return Response.json({ error: 'Espera antes de cambiar nuevamente la preferencia.' }, { status: 429 });
  const body = await request.json().catch(() => null);
  if (typeof body?.enabled !== 'boolean') {
    return Response.json({ error: 'Preferencia inválida.' }, { status: 400 });
  }
  const source = body?.source === 'mobile' ? 'mobile' : 'web';
  await recordMarketingPreference(
    user.id,
    body.enabled,
    prepareLegalEvidence(request, source, body.enabled ? 'marketing-consent' : 'marketing-withdrawal'),
  );
  return Response.json({ ok: true, ...(await currentMarketingPreference(user.id)) });
}
