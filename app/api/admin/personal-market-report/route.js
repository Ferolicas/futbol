import { createSupabaseServerClient } from '../../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../../lib/supabase';
import { buildFootballFirstHalfCornersReport } from '../../../../lib/football-first-half-corners-report';
import { buildBaseballPersonalMarketReport } from '../../../../lib/baseball-personal-market-report';
import { bogotaToday } from '../../../../lib/telegram-premium-picks';
import { jsonError } from '../../../../lib/api-error';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function isStaff() {
  const auth = createSupabaseServerClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return false;
  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  return ['admin', 'owner'].includes(profile?.role);
}

export async function GET(request) {
  if (!(await isStaff())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || bogotaToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: 'Fecha inválida' }, { status: 400 });
  const sport = searchParams.get('sport') === 'baseball' ? 'baseball' : 'futbol';
  try {
    const report = sport === 'baseball'
      ? await buildBaseballPersonalMarketReport(date)
      : await buildFootballFirstHalfCornersReport(date);
    return new Response(report.content, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${report.filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
