/**
 * POST /api/auth-pg/reset-password — consume token + cambia password
 * Body: { token, newPassword }
 *
 * Side effect: revoca TODAS las sesiones del user (fuerza re-login en
 * todos los devices). Esto previene que un atacante con cookie robada
 * mantenga acceso tras un reset legítimo.
 */

import { consumePasswordResetToken } from '../../../../lib/auth-pg';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: 'INVALID_JSON' }, { status: 400 }); }
  const { token, newPassword } = body || {};
  const result = await consumePasswordResetToken(token, newPassword);
  if (result.error) return Response.json({ error: result.error }, { status: 400 });
  return Response.json({ ok: true });
}
