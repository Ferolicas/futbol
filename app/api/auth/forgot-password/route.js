import crypto from 'crypto';
import { pgQuery } from '../../../../lib/db';
import { redisSet } from '../../../../lib/redis';
import { sendPasswordResetEmail } from '../../../../lib/email';
import { redisRateLimit, clientIp } from '../../../../lib/ratelimit-redis';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    // A2: rate-limit compartido (Redis) — 5/min/IP anti enumeración/spam de emails.
    const rl = await redisRateLimit('forgot', clientIp(request), 5, 60);
    if (!rl.success) {
      return Response.json({ error: 'Demasiados intentos. Espera un momento.' }, { status: 429 });
    }

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

    // El envío de email NO debe tumbar el endpoint. Si el proveedor falla
    // (p.ej. ZeptoMail "Credit exhausted" → 429, o key/sender mal config),
    // sendEmail lanza. Antes eso devolvía 500 SOLO para usuarios existentes,
    // mientras los inexistentes devuelven 200 → fuga de enumeración de cuentas.
    // Capturamos, logueamos para observabilidad, y respondemos success igual.
    try {
      await sendPasswordResetEmail({
        to: emailLower,
        name: user.name,
        token,
      });
    } catch (mailErr) {
      console.error('[ForgotPassword] envío de email falló:', mailErr.message);
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error('[ForgotPassword]', error.message);
    return Response.json({ error: 'Error al procesar la solicitud' }, { status: 500 });
  }
}
