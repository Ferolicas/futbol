/**
 * GET /api/admin/audit-logs?limit=50&offset=0
 *
 * Devuelve registros de audit_logs ordenados por created_at desc.
 * Solo accesible por admin/owner (middleware ya valida /admin/* pero el role
 * check se repite aqui para defense-in-depth).
 */
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../../lib/supabase';

export const dynamic = 'force-dynamic';

async function requireAdmin() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile || !['admin', 'owner'].includes(profile.role)) return null;
  return user;
}

export async function GET(request) {
  const user = await requireAdmin();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const limit  = Math.min(Math.max(Number(searchParams.get('limit')  || 50), 1), 500);
  const offset = Math.max(Number(searchParams.get('offset') || 0), 0);

  try {
    const { data, error } = await supabaseAdmin
      .from('audit_logs')
      .select('id, user_email, action, entity, entity_id, payload, ip, created_at')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) {
      // Tabla aun no creada → devolver lista vacia (no romper la pagina).
      if (error.code === '42P01') return Response.json({ logs: [] });
      throw error;
    }
    return Response.json({ logs: data || [] });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
