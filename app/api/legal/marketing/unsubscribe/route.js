import {
  prepareLegalEvidence,
  recordMarketingPreference,
  verifyMarketingUnsubscribeToken,
} from '../../../../../lib/legal';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  let token = new URL(request.url).searchParams.get('token');
  if (!token) {
    const type = request.headers.get('content-type') || '';
    if (type.includes('application/json')) token = (await request.json().catch(() => null))?.token;
    else token = (await request.formData().catch(() => null))?.get('token');
  }
  const userId = verifyMarketingUnsubscribeToken(token);
  if (!userId) return Response.json({ error: 'Enlace inválido.' }, { status: 400 });
  await recordMarketingPreference(
    userId,
    false,
    prepareLegalEvidence(request, 'email', 'marketing-withdrawal'),
  );
  return Response.json({ ok: true });
}
