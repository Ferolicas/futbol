/**
 * POST /api/auth-pg/forgot-password — genera token + envía email reset
 *
 * NO revela si el email existe (siempre devuelve ok). El email solo
 * llega si el user existe realmente.
 */

import { createPasswordResetToken } from '../../../../lib/auth-pg';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return Response.json({ ok: true }); }
  const { email } = body || {};
  if (!email) return Response.json({ ok: true });  // no leak

  const { tokenForEmail, userId } = await createPasswordResetToken(email);

  if (tokenForEmail && userId) {
    // TODO: enviar email con link al reset:
    //   https://cfanalisis.com/reset-password?token=${tokenForEmail}
    // const { sendZeptoMail } = await import('../../../../lib/zeptomail');
    // await sendZeptoMail(email, 'Restablece tu contraseña', resetTemplate({ token: tokenForEmail }));
    console.log(`[auth-pg] password reset token created for user ${userId} (TODO wire email send)`);
  }

  return Response.json({ ok: true });
}
