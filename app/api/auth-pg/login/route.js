/**
 * POST /api/auth-pg/login
 *
 * Login con email + password. Cookie cf_session se establece en exito.
 * Body: { email, password }
 *
 * Codigos de error:
 *   INVALID_CREDENTIALS  — email o password incorrectos
 *   LOCKED               — cuenta bloqueada por 5+ fallos
 *   NEEDS_RESET          — user migrado de Supabase sin password local
 */

import { loginUser } from '../../../../lib/auth-pg';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: 'INVALID_JSON' }, { status: 400 }); }
  const { email, password } = body || {};

  const userAgent = req.headers.get('user-agent') || null;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;

  const result = await loginUser(email, password, { userAgent, ip });
  if (result.error) {
    return Response.json({ error: result.error }, { status: result.error.code === 'LOCKED' ? 423 : 401 });
  }

  return Response.json({ ok: true, user: result.user });
}
