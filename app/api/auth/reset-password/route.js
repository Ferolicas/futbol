// Reset password — auth nativo PG VPS (Fase 2.5 cerrada).
// El token de reset lo genera forgot-password en Redis (pwd-reset:{token}).
// Aquí validamos el token y escribimos el hash bcrypt directo en la tabla
// `users` del VPS (antes: supabaseAdmin.auth.admin.updateUserById).
import bcrypt from 'bcryptjs';
import { pgQuery } from '../../../../lib/db';
import { redisGet, redisDel } from '../../../../lib/redis';

export const dynamic = 'force-dynamic';

const BCRYPT_ROUNDS = 10;

export async function POST(request) {
  try {
    const { token, password } = await request.json();

    if (!token?.trim()) {
      return Response.json({ error: 'Token requerido' }, { status: 400 });
    }
    if (!password || password.length < 6) {
      return Response.json({ error: 'La contrasena debe tener al menos 6 caracteres' }, { status: 400 });
    }

    // Token en Redis (puesto por forgot-password con TTL 1h)
    const tokenData = await redisGet(`pwd-reset:${token}`);
    if (!tokenData?.userId) {
      return Response.json({ error: 'Enlace invalido o expirado' }, { status: 400 });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Escribir hash en users + resetear lockout. Revocar todas las sesiones
    // para forzar re-login en todos los dispositivos.
    await pgQuery(
      `UPDATE public.users SET
         password_hash = $1,
         failed_login_attempts = 0,
         locked_until = NULL,
         password_reset_token = NULL,
         password_reset_expires = NULL
       WHERE id = $2`,
      [passwordHash, tokenData.userId],
    );
    await pgQuery('DELETE FROM public.auth_sessions WHERE user_id = $1', [tokenData.userId]).catch(() => {});

    await redisDel(`pwd-reset:${token}`);

    return Response.json({ success: true });
  } catch (error) {
    console.error('[ResetPassword]', error.message);
    return Response.json({ error: 'Error al restablecer la contrasena' }, { status: 500 });
  }
}
