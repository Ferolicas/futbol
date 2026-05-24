// Sesión actual — auth nativo PG VPS. Lee la cookie httpOnly (JWT), valida
// contra auth_sessions y devuelve user + perfil. Lo consume el AuthProvider
// del cliente (no puede leer la cookie httpOnly directamente).
import { getCurrentUser } from '../../../../lib/auth-pg';
import { supabaseAdmin } from '../../../../lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ user: null });

    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('id, email, name, role, plan, subscription_status, timezone, custom_league_ids')
      .eq('id', user.id)
      .single();

    return Response.json({
      user: {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerified,
        ...(profile || {}),
      },
    });
  } catch (err) {
    console.error('[auth/session]', err.message);
    return Response.json({ user: null });
  }
}
