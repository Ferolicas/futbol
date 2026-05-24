// Logout — auth nativo PG VPS. Borra la sesión de auth_sessions y limpia
// la cookie. Reemplaza supabase.auth.signOut() del browser.
import { logoutUser } from '../../../../lib/auth-pg';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    await logoutUser();
    return Response.json({ success: true });
  } catch (error) {
    console.error('[Logout]', error.message);
    // Aunque falle el borrado en DB, devolvemos ok — la cookie ya se limpió.
    return Response.json({ success: true });
  }
}
