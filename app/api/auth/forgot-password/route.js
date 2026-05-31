import crypto from 'crypto';
import { pgQuery } from '../../../../lib/db';
import { redisSet } from '../../../../lib/redis';
import { sendPasswordResetEmail } from '../../../../lib/zeptomail';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const { email } = await request.json();
    if (!email?.trim()) {
      return Response.json({ error: 'Email requerido' }, { status: 400 });
    }

    const emailLower = email.toLowerCase().trim();

    // BUG FIX (reset no funcionaba para usuarios migrados): antes se buscaba en
    // `user_profiles`, pero la tabla de AUTH es `public.users` (donde reset-password
    // escribe el hash). Los usuarios migrados de Supabase (migrate-supabase-users-to-pg)
    // viven en `users` y NO siempre tienen fila en `user_profiles` → forgot-password
    // no los encontraba y nunca enviaba el enlace. Buscamos en `public.users` (fuente
    // de verdad de auth) y dejamos user_profiles solo para el nombre del saludo.
    const { rows } = await pgQuery(
      `SELECT u.id, u.email, COALESCE(p.name, u.display_name) AS name
       FROM public.users u
       LEFT JOIN user_profiles p ON p.id = u.id
       WHERE LOWER(u.email) = $1
       LIMIT 1`,
      [emailLower],
    );
    const user = rows[0];

    // Always return success to prevent email enumeration
    if (!user) {
      return Response.json({ success: true });
    }

    // Generate secure token — store in Redis with 1-hour TTL
    const token = crypto.randomBytes(32).toString('hex');
    await redisSet(`pwd-reset:${token}`, { userId: user.id, email: emailLower }, 3600);

    await sendPasswordResetEmail({
      to: emailLower,
      name: user.name,
      token,
    });

    return Response.json({ success: true });
  } catch (error) {
    console.error('[ForgotPassword]', error.message);
    return Response.json({ error: 'Error al procesar la solicitud' }, { status: 500 });
  }
}
