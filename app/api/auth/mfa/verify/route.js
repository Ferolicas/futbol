import { createAuthenticatedSession } from '../../../../../lib/auth-pg';
import { verifyAdminMfaChallenge } from '../../../../../lib/auth-mfa';
import { pgQuery } from '../../../../../lib/db';
import { redisRateLimit, clientIp } from '../../../../../lib/ratelimit-redis';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const limit = await redisRateLimit('admin-mfa-verify', clientIp(request), 10, 10 * 60, { failClosed: true });
  if (!limit.success) {
    return Response.json(
      { error: limit.available ? 'Demasiados intentos. Solicita un código nuevo.' : 'Servicio temporalmente no disponible.' },
      { status: limit.available ? 429 : 503 },
    );
  }
  const body = await request.json().catch(() => null);
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  const challenge = await verifyAdminMfaChallenge(code);
  if (!challenge) return Response.json({ error: 'Código inválido o expirado.' }, { status: 401 });

  const result = await pgQuery(
    `SELECT u.id, u.email, u.email_verified, p.role
       FROM public.users u
       JOIN public.user_profiles p ON p.id = u.id
      WHERE u.id = $1 AND u.email_verified = true AND p.role IN ('admin', 'owner')
      LIMIT 1`,
    [challenge.userId],
  );
  const user = result.rows[0];
  if (!user) return Response.json({ error: 'Acceso no autorizado.' }, { status: 403 });

  const ua = request.headers.get('user-agent') || null;
  const ip = clientIp(request);
  await createAuthenticatedSession(user.id, { userAgent: ua, ip });
  return Response.json({ success: true, user: { id: user.id, email: user.email } });
}
