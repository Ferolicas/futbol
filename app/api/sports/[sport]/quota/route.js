import { getApiSportsQuota } from '../../../../../lib/api-sports-multisport';
import { getMultisportConfig } from '../../../../../lib/multisport-config';
import { getCurrentUser } from '../../../../../lib/auth-pg';
import { jsonError } from '../../../../../lib/api-error';

export const dynamic = 'force-dynamic';

export async function GET(_request, { params }) {
  try {
    if (!(await getCurrentUser())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const config = getMultisportConfig(params.sport);
    const providerNames = config.key === 'basketball' ? ['nba', 'basketball'] : ['american_football'];
    const quotas = await Promise.all(providerNames.map((provider) => getApiSportsQuota(provider)));
    const primary = quotas[0];
    return Response.json({
      used: primary.used, limit: primary.budget, remaining: primary.remaining,
      date: primary.date, source: `api-${primary.provider}`,
      providers: Object.fromEntries(quotas.map((quota) => [quota.provider, {
        used: quota.used, limit: quota.budget, remaining: quota.remaining,
      }])),
    });
  } catch (error) {
    return jsonError(error);
  }
}
