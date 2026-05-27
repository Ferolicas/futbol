/**
 * GET /api/baseball/fixtures?date=YYYY-MM-DD&tz=<IANA>
 *
 * Lista los juegos MLB del día (zona horaria del cliente) desde la MLB Stats
 * API oficial (statsapi.mlb.com) — api-baseball no sirve para MLB (plan free
 * 2022-2024, sin pitchers). Enriquece con el análisis (probabilidades,
 * combinada) y el estado en vivo (baseball_match_results), ambos por gamePk.
 *
 * Mapea el game de MLB Stats API al shape que el frontend ya consume (id,
 * date, status:{short,long}, teams, scores, league) para no reescribir la UI.
 */
import { getMlbScheduleByDate } from '../../../../lib/mlb-stats-api';
import { supabaseAdmin } from '../../../../lib/supabase';
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';

export const dynamic = 'force-dynamic';

const SPORT_IDS = [1]; // MLB (añadir 11/12 para MiLB)

function localDateOf(utcIso, tz) {
  if (!utcIso) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(utcIso));
  } catch { return utcIso.split('T')[0]; }
}

// MLB Stats API game → shape compatible con el frontend (estilo api-baseball).
function toFixtureShape(g) {
  const short = g.isFinal ? 'FT' : (g.isLive ? 'IN' : 'NS');
  return {
    id: g.gamePk,
    date: g.dateUTC,
    status: { short, long: g.status, inning: g.inning },
    league: { id: 1, name: 'MLB' },
    country: { name: 'USA' },
    teams: {
      home: { id: g.home.id, name: g.home.name, abbreviation: g.home.abbreviation },
      away: { id: g.away.id, name: g.away.name, abbreviation: g.away.abbreviation },
    },
    scores: {
      home: { total: g.home.score },
      away: { total: g.away.score },
    },
    probablePitchers: {
      home: g.home.probablePitcherName || null,
      away: g.away.probablePitcherName || null,
    },
  };
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const userTz = searchParams.get('tz') || 'UTC';
    const todayUtc = new Date().toISOString().split('T')[0];
    const date = searchParams.get('date') || todayUtc;
    const isPast = date < todayUtc;

    const supabase = createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();

    // Un día local cubre 2 días UTC → pedir fechas adyacentes y filtrar por TZ.
    const d = new Date(date + 'T12:00:00Z');
    const prevDay = new Date(d.getTime() - 86400000).toISOString().split('T')[0];
    const nextDay = new Date(d.getTime() + 86400000).toISOString().split('T')[0];
    const fetchDates = userTz !== 'UTC' ? [prevDay, date, nextDay] : [date];

    // Schedule MLB de las fechas necesarias (todas en paralelo).
    const schedLists = await Promise.all(
      fetchDates.flatMap(dt => SPORT_IDS.map(sid =>
        getMlbScheduleByDate(dt, sid).catch(() => [])
      ))
    );
    const seen = new Set();
    const merged = [];
    for (const g of schedLists.flat()) {
      if (!g?.gamePk || seen.has(g.gamePk)) continue;
      seen.add(g.gamePk);
      merged.push(g);
    }

    // Filtrar al día local del usuario.
    let games = merged.filter(g => localDateOf(g.dateUTC, userTz) === date);
    // Cross-midnight live: incluir juegos en vivo de otra fecha.
    if (!isPast) {
      const ids = new Set(games.map(g => g.gamePk));
      for (const g of merged) {
        if (g.isLive && !ids.has(g.gamePk)) { games.push(g); ids.add(g.gamePk); }
      }
    }

    const fixtures = games.map(toFixtureShape);
    const allFids = fixtures.map(f => Number(f.id));

    const [analysesRes, resultsRes, hiddenRes, favoritesRes] = await Promise.all([
      allFids.length ? supabaseAdmin.from('baseball_match_analysis').select('fixture_id, probabilities, combinada, data_quality, best_odds, analysis').in('fixture_id', allFids) : Promise.resolve({ data: [] }),
      allFids.length ? supabaseAdmin.from('baseball_match_results').select('fixture_id, status, inning, inning_half, home_score, away_score, home_hits, away_hits, home_errors, away_errors').in('fixture_id', allFids) : Promise.resolve({ data: [] }),
      user ? supabaseAdmin.from('baseball_user_hidden').select('fixture_id').eq('user_id', user.id) : Promise.resolve({ data: [] }),
      user ? supabaseAdmin.from('baseball_user_favorites').select('fixture_id').eq('user_id', user.id) : Promise.resolve({ data: [] }),
    ]);

    const toNum = (v) => Number(v);
    const analysisMap = new Map((analysesRes.data || []).map(a => [toNum(a.fixture_id), a]));
    const resultsMap = new Map((resultsRes.data || []).map(r => [toNum(r.fixture_id), r]));
    const hiddenSet = new Set((hiddenRes.data || []).map(h => toNum(h.fixture_id)));
    const favoritesSet = new Set((favoritesRes.data || []).map(f => toNum(f.fixture_id)));

    const enriched = fixtures.map(f => {
      const fid = toNum(f.id);
      return {
        ...f,
        analysis: analysisMap.get(fid) || null,
        liveResult: resultsMap.get(fid) || null,
        isAnalyzed: analysisMap.has(fid),
        isHidden: hiddenSet.has(fid),
        isFavorite: favoritesSet.has(fid),
      };
    });
    enriched.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    return Response.json({ success: true, date, userTz, fetchedDates: fetchDates, fixtures: enriched, count: enriched.length });
  } catch (e) {
    console.error('[api/baseball/fixtures]', e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
