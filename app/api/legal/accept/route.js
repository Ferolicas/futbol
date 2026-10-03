import { getCurrentUser } from '../../../../lib/auth-pg';
import {
  LEGAL_DOCUMENT_VERSION,
  prepareLegalEvidence,
  recordLegalAcceptance,
  recordMarketingPreference,
} from '../../../../lib/legal';
import { redisRateLimit } from '../../../../lib/ratelimit-redis';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const limit = await redisRateLimit('legal-accept', user.id, 6, 10 * 60, { failClosed: true });
  if (!limit.success) return Response.json({ error: 'Espera un momento e inténtalo de nuevo.' }, { status: 429 });

  const body = await request.json().catch(() => null);
  if (body?.acceptAll !== true || body?.version !== LEGAL_DOCUMENT_VERSION) {
    return Response.json({ error: 'La aceptación no corresponde a los documentos vigentes.' }, { status: 400 });
  }
  const source = body?.source === 'mobile' ? 'mobile' : 'web';
  await recordLegalAcceptance(user.id, prepareLegalEvidence(request, source));
  if (body?.marketingConsent === true) {
    await recordMarketingPreference(
      user.id,
      true,
      prepareLegalEvidence(request, source, 'marketing-consent'),
    );
  }
  return Response.json({ ok: true, version: LEGAL_DOCUMENT_VERSION });
}
