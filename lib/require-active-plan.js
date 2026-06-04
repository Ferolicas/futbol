// ──────────────────────────────────────────────────────────────────────────
// Gate de plan de pago — patrón extraído de baseball.
//
// Replica EXACTAMENTE la lógica que ya usa app/api/baseball/analisis/route.js:
//   const isAdmin  = ['admin', 'owner'].includes(profile?.role);
//   const isActive = ['active', 'trialing'].includes(profile?.subscription_status);
//   acceso = isAdmin || isActive;
//
// Recibe el usuario YA autenticado. El caller es responsable de resolver la
// sesión y devolver 401 ('Unauthorized') si el usuario es null ANTES de llamar
// aquí. Esta función solo decide el acceso de pago (no toca la sesión).
//
// Devuelve true si el usuario tiene acceso (admin/owner o plan active/trialing),
// false en caso contrario.
// ──────────────────────────────────────────────────────────────────────────
import { supabaseAdmin } from './supabase';

export async function userHasActivePlan(user) {
  if (!user?.id) return false;
  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('role, subscription_status')
    .eq('id', user.id)
    .single();
  const isAdmin = ['admin', 'owner'].includes(profile?.role);
  const isActive = ['active', 'trialing'].includes(profile?.subscription_status);
  return isAdmin || isActive;
}
