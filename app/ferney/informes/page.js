import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../lib/supabase';
import { buildFootballFirstHalfCornersReport } from '../../../lib/football-first-half-corners-report';
import { buildBaseballPersonalMarketReport } from '../../../lib/baseball-personal-market-report';
import { bogotaToday } from '../../../lib/telegram-premium-picks';
import MarketReports from './MarketReports';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export const metadata = { title: 'Informes privados · CF Análisis', robots: 'noindex,nofollow' };

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : bogotaToday();
}

export default async function PersonalReportsPage({ searchParams }) {
  const date = validDate(searchParams?.date);
  const initialSport = searchParams?.deporte === 'baseball' ? 'baseball' : 'futbol';
  const selectedTeamId = /^\d+$/.test(String(searchParams?.equipo || ''))
    ? Number(searchParams.equipo)
    : null;
  const teamParam = selectedTeamId ? `&equipo=${selectedTeamId}` : '';
  const destination = `/ferney/informes?date=${encodeURIComponent(date)}&deporte=${initialSport}${teamParam}`;
  const auth = createSupabaseServerClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) redirect(`/sign-in?redirect_url=${encodeURIComponent(destination)}`);

  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('role,email')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile || !['admin', 'owner'].includes(profile.role)) redirect('/dashboard');

  const [football, baseball] = await Promise.all([
    buildFootballFirstHalfCornersReport(date, { selectedTeamId }),
    buildBaseballPersonalMarketReport(date),
  ]);
  const serialize = value => JSON.parse(JSON.stringify(value));

  return (
    <MarketReports
      date={date}
      initialSport={initialSport}
      reports={{ futbol: serialize(football), baseball: serialize(baseball) }}
      userEmail={profile.email || user.email}
    />
  );
}
