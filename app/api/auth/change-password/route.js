// Cambiar contraseña — usuario con sesión activa (menú de cuenta).
// Requiere la contraseña actual (bcrypt.compare en lib/auth-pg.changePassword)
// y no toca las demás sesiones del usuario (a diferencia del reset por token).
import { getCurrentUser, changePassword } from '../../../../lib/auth-pg';
import { redisRateLimit, clientIp } from '../../../../lib/ratelimit-redis';

export const dynamic = 'force-dynamic';

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

    const { currentPassword, newPassword, confirmPassword } = await request.json();

    if (!currentPassword || !newPassword || !confirmPassword) {
      return Response.json({ error: 'Completa todos los campos' }, { status: 400 });
    }
    if (newPassword !== confirmPassword) {
      return Response.json({ error: 'Las contraseñas no coinciden' }, { status: 400 });
    }
    if (newPassword.length < 8) {
      return Response.json({ error: 'La contraseña debe tener al menos 8 caracteres' }, { status: 400 });
    }

    const result = await changePassword(user.id, currentPassword, newPassword);
    if (result.error) {
      const status = result.error.code === 'INVALID_OLD' ? 400 : result.error.code === 'NOT_FOUND' ? 404 : 400;
      return Response.json({ error: result.error.message }, { status });
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error('[ChangePassword]', error.message);
    return Response.json({ error: 'Error al cambiar la contraseña' }, { status: 500 });
  }
}
