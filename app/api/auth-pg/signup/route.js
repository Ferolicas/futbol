/**
 * POST /api/auth-pg/signup
 *
 * Crea usuario nuevo en PG VPS (no usa Supabase Auth).
 * Body: { email, password, displayName? }
 *
 * Side effects:
 *   - Crea fila en users + user_profiles
 *   - Crea session (cookie httpOnly cf_session)
 *   - Genera email_verification_token, devuelve plain para enviar email
 *     (TODO: hacer wire del envio via ZeptoMail aqui)
 */

import { signupUser } from '../../../../lib/auth-pg';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: 'INVALID_JSON' }, { status: 400 }); }
  const { email, password, displayName } = body || {};

  const userAgent = req.headers.get('user-agent') || null;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;

  const result = await signupUser(email, password, { displayName, userAgent, ip });
  if (result.error) return Response.json({ error: result.error }, { status: 400 });

  // TODO: enviar email de verificación con `result.emailVerifyToken`.
  // Ejemplo: await sendEmail(email, 'Verifica tu cuenta', verifyLink(result.emailVerifyToken));

  return Response.json({
    ok: true,
    user: result.user,
    needsEmailVerification: !result.user.emailVerified,
  });
}
