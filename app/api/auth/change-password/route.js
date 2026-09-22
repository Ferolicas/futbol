// Cambiar contraseña — usuario con sesión activa (menú de cuenta).
// Pide solo la nueva contraseña y su confirmación (sin contraseña actual),
// igual que el resto de auth nativo en PG VPS (bcrypt directo).
import bcrypt from 'bcryptjs';
import { getCurrentUser } from '../../../../lib/auth-pg';
import { pgQuery } from '../../../../lib/db';
import { redisRateLimit, clientIp } from '../../../../lib/ratelimit-redis';

export const dynamic = 'force-dynamic';

const BCRYPT_ROUNDS = 10;

export async function POST(request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'No autenticado' }, { status: 401 });

    const rl = await redisRateLimit('change-password', clientIp(request), 10, 60, { failClosed: true });
    if (!rl.success) {
      return Response.json(
        { error: rl.available ? 'Demasiados intentos. Espera un momento.' : 'Servicio temporalmente no disponible.' },
        { status: rl.available ? 429 : 503, headers: { 'Retry-After': '60' } },
      );
    }

    const { newPassword, confirmPassword } = await request.json();

    if (!newPassword || !confirmPassword) {
      return Response.json({ error: 'Completa todos los campos' }, { status: 400 });
    }
    if (newPassword !== confirmPassword) {
      return Response.json({ error: 'Las contraseñas no coinciden' }, { status: 400 });
    }
    if (newPassword.length < 8) {
      return Response.json({ error: 'La contraseña debe tener al menos 8 caracteres' }, { status: 400 });
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await pgQuery('UPDATE public.users SET password_hash = $1 WHERE id = $2', [passwordHash, user.id]);

    return Response.json({ success: true });
  } catch (error) {
    console.error('[ChangePassword]', error.message);
    return Response.json({ error: 'Error al cambiar la contraseña' }, { status: 500 });
  }
}
