import { supabaseAdmin } from '../../../../lib/supabase';
import { redisGet, redisDel } from '../../../../lib/redis';

export async function POST(request) {
  try {
    const { token, password } = await request.json();

    if (!token?.trim()) {
      return Response.json({ error: 'Token requerido' }, { status: 400 });
    }
    if (!password || password.length < 6) {
      return Response.json({ error: 'La contrasena debe tener al menos 6 caracteres' }, { status: 400 });
    }

    // Look up token in Redis
    const tokenData = await redisGet(`pwd-reset:${token}`);
    if (!tokenData) {
      return Response.json({ error: 'Enlace invalido o expirado' }, { status: 400 });
    }

    // Update password via Supabase Auth (Supabase handles hashing)
    const { error } = await supabaseAdmin.auth.admin.updateUserById(tokenData.userId, { password });
    if (error) {
      console.error('[ResetPassword] updateUser:', error.message);
      return Response.json({ error: 'Error al actualizar la contrasena' }, { status: 500 });
    }

    // Delete used token
    await redisDel(`pwd-reset:${token}`);

    return Response.json({ success: true });
  } catch (error) {
    console.error('[ResetPassword]', error.message);
    return Response.json({ error: 'Error al restablecer la contrasena' }, { status: 500 });
  }
}
