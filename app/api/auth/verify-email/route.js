import { createAuthenticatedSession, verifyEmail } from '../../../../lib/auth-pg';
import { pgQuery } from '../../../../lib/db';
import { sendWelcomeEmail } from '../../../../lib/email';
import { redisRateLimit, clientIp } from '../../../../lib/ratelimit-redis';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const limit = await redisRateLimit('verify-email', clientIp(request), 20, 60 * 60, { failClosed: true });
  if (!limit.success) {
    return Response.json({ error: 'Demasiados intentos. Solicita un enlace nuevo.' }, { status: 429 });
  }
  const body = await request.json().catch(() => null);
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!/^[0-9a-f]{64}$/i.test(token)) {
    return Response.json({ error: 'Enlace inválido o expirado.' }, { status: 400 });
  }
  const result = await verifyEmail(token);
  if (result.error) return Response.json({ error: 'Enlace inválido o expirado.' }, { status: 400 });

  const accountResult = await pgQuery(
    `SELECT u.email, COALESCE(p.name, u.display_name) AS name
       FROM public.users u LEFT JOIN public.user_profiles p ON p.id = u.id
      WHERE u.id = $1 LIMIT 1`,
    [result.userId],
  );
  const account = accountResult.rows[0];
  const ua = request.headers.get('user-agent') || null;
  const ip = clientIp(request);
  await createAuthenticatedSession(result.userId, { userAgent: ua, ip });
  if (account?.email) {
    sendWelcomeEmail({ to: account.email, name: account.name }).catch((error) => {
      console.error('[VerifyEmail] welcome email failed:', error.message);
    });
  }
  return Response.json({ success: true });
}
