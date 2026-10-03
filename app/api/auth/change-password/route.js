// Solicitud autenticada de cambio de contraseña. Nunca cambia la clave desde
// una sesión abierta: envía un enlace de un solo uso al correo registrado.
import { getCurrentUser } from '../../../../lib/auth-pg';
import { pgQuery } from '../../../../lib/db';
import { issuePasswordReset } from '../../../../lib/password-reset';
import { redisRateLimit, clientIp } from '../../../../lib/ratelimit-redis';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'No autenticado' }, { status: 401 });

    const [byUser, byIp] = await Promise.all([
      redisRateLimit('change-password-user', user.id, 3, 60 * 60, { failClosed: true }),
      redisRateLimit('change-password-ip', clientIp(request), 10, 60 * 60, { failClosed: true }),
    ]);
    if (!byUser.success || !byIp.success) {
      const available = byUser.available && byIp.available;
      return Response.json(
        { error: available ? 'Ya enviamos varios enlaces. Espera antes de solicitar otro.' : 'Servicio temporalmente no disponible.' },
        { status: available ? 429 : 503, headers: { 'Retry-After': '3600' } },
      );
    }

    const profile = await pgQuery(
      `SELECT COALESCE(p.name, u.display_name) AS name, u.email
         FROM public.users u
         LEFT JOIN public.user_profiles p ON p.id = u.id
        WHERE u.id = $1 LIMIT 1`,
      [user.id],
    );
    const account = profile.rows[0];
    if (!account?.email) return Response.json({ error: 'Cuenta no disponible' }, { status: 404 });

    await issuePasswordReset({ userId: user.id, email: account.email, name: account.name });
    return Response.json({ success: true });
  } catch (error) {
    console.error('[ChangePasswordLink]', error.message);
    return Response.json({ error: 'No se pudo enviar el enlace. Intenta de nuevo.' }, { status: 503 });
  }
}
