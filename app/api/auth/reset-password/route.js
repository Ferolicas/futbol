// Reset password — auth nativo PG VPS (Fase 2.5 cerrada).
// El token de reset se guarda hasheado en Redis y se consume de forma atómica.
// Aquí validamos el token y escribimos el hash bcrypt directo en la tabla
// `users` del VPS (antes: supabaseAdmin.auth.admin.updateUserById).
import bcrypt from 'bcryptjs';
import { pgPool } from '../../../../lib/db';
import { redisRateLimit, clientIp } from '../../../../lib/ratelimit-redis';
import { takePasswordReset } from '../../../../lib/password-reset';
import { validateNewPassword } from '../../../../lib/password-policy';

export const dynamic = 'force-dynamic';

const BCRYPT_ROUNDS = 10;

export async function POST(request) {
  try {
    // A2: rate-limit compartido (Redis) — 20/min/IP anti fuerza-bruta de tokens.
    const rl = await redisRateLimit('reset', clientIp(request), 20, 60, { failClosed: true });
    if (!rl.success) {
      return Response.json(
        { error: rl.available ? 'Demasiados intentos. Espera un momento.' : 'Servicio temporalmente no disponible.' },
        { status: rl.available ? 429 : 503, headers: { 'Retry-After': '60' } },
      );
    }

    const body = await request.json().catch(() => null);
    const { token, password, confirmPassword } = body || {};

    if (!token?.trim()) {
      return Response.json({ error: 'Token requerido' }, { status: 400 });
    }
    if (password !== confirmPassword) {
      return Response.json({ error: 'Las contraseñas no coinciden' }, { status: 400 });
    }
    const passwordValidation = validateNewPassword(password);
    if (!passwordValidation.success) {
      return Response.json({ error: passwordValidation.error }, { status: 400 });
    }

    // Token en Redis (puesto por forgot-password con TTL 1h)
    const tokenData = await takePasswordReset(token);
    if (!tokenData?.userId) {
      return Response.json({ error: 'Enlace invalido o expirado' }, { status: 400 });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Escribir hash en users + resetear lockout. Revocar todas las sesiones
    // para forzar re-login en todos los dispositivos.
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE public.users SET
           password_hash = $1,
           failed_login_attempts = 0,
           locked_until = NULL,
           password_reset_token = NULL,
           password_reset_expires = NULL
         WHERE id = $2`,
        [passwordHash, tokenData.userId],
      );
      await client.query('DELETE FROM public.auth_sessions WHERE user_id = $1', [tokenData.userId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error('[ResetPassword]', error.message);
    return Response.json({ error: 'Error al restablecer la contrasena' }, { status: 500 });
  }
}
