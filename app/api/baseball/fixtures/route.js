/**
 * GET /api/baseball/fixtures?date=YYYY-MM-DD&tz=<IANA>
 *
 * Lista los partidos MLB del día (zona horaria del cliente) desde MLB Stats
 * API oficial (statsapi.mlb.com) — api-baseball no sirve para MLB (plan free
 * 2022-2024, sin pitchers). Enriquece con el análisis (probabilidades,
 * combinada) y el estado en vivo (baseball_match_results), ambos por gamePk.
 *
 * Mapea el game de MLB Stats API al shape que el frontend ya consume (id,
 * date, status:{short,long}, teams, scores, league) para no reescribir la UI.
 */
import { getMlbScheduleByDate, MLB_SPORT_IDS } from '../../../../lib/mlb-stats-api';
import { supabaseAdmin } from '../../../../lib/supabase';
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';
import { userHasActivePlan } from '../../../../lib/require-active-plan';
import { jsonError } from '../../../../lib/api-error';
import { MULTISPORT_CACHE_VERSION } from '../../../../lib/multisport-analysis';
import { enqueue } from '../../../../lib/worker-client';

export const dynamic = 'force-dynamic';

const SPORT_IDS = Object.keys(MLB_SPORT_IDS).map(Number);

function localDateOf(utcIso, tz) {
  if (!utcIso) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(utcIso));
  } catch { return utcIso.split('T')[0]; }
}

// Logo oficial del equipo MLB (SVG público de mlbstatic, por team id).
const mlbLogo = (teamId) => teamId ? `https://www.mlbstatic.com/team-logos/${teamId}.svg` : null;

// MLB Stats API game → shape compatible con el frontend (estilo api-baseball).
function toFixtureShape(g) {
  const short = g.isFinal ? 'FT' : (g.isLive ? 'IN' : 'NS');
  return {
    id: g.gamePk,
    date: g.dateUTC,
    status: { short, long: g.status, inning: g.inning },
    league: { id: Number(g.sportId || 1), name: g.sportName || MLB_SPORT_IDS[g.sportId] || 'MLB' },
    country: { name: 'Estados Unidos' },
    teams: {
      home: { id: g.home.id, name: g.home.name, abbreviation: g.home.abbreviation, logo: mlbLogo(g.home.id) },
      away: { id: g.away.id, name: g.away.name, abbreviation: g.away.abbreviation, logo: mlbLogo(g.away.id) },
    },
    scores: {
      home: { total: g.home.score },
      away: { total: g.away.score },
    },
    probablePitchers: {
      home: g.home.probablePitcherName || null,
      away: g.away.probablePitcherName || null,
      homeId: g.home.probablePitcherId || null,
      awayId: g.away.probablePitcherId || null,
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

    // Contenido de pago: exigir sesión + plan activo/admin ANTES de cargar nada
    // (igual que /api/fixtures de fútbol). Antes este endpoint servía el análisis
    // completo — probabilidades, líneas, picks de jugadores — a usuarios anónimos.
    const supabase = createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!(await userHasActivePlan(user))) {
      return Response.json({ error: 'Subscription required' }, { status: 403 });
    }

    // Un día local cubre 2 días UTC → pedir fechas adyacentes y filtrar por TZ.
    const d = new Date(date + 'T12:00:00Z');
    const prevDay = new Date(d.getTime() - 86400000).toISOString().split('T')[0];
    const nextDay = new Date(d.getTime() + 86400000).toISOString().split('T')[0];
    const fetchDates = userTz !== 'UTC' ? [prevDay, date, nextDay] : [date];

    // Schedule MLB de las fechas necesarias (todas en paralelo).
    const schedLists = await Promise.all(
      fetchDates.map((dt) => getMlbScheduleByDate(dt, SPORT_IDS).catch(() => [])),
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
      allFids.length ? supabaseAdmin.from('baseball_match_analysis').select('fixture_id, combinada, data_quality, best_odds, analysis, cache_version').in('fixture_id', allFids) : Promise.resolve({ data: [] }),
      allFids.length ? supabaseAdmin.from('baseball_match_results').select('fixture_id, status, inning, inning_half, home_score, away_score, home_hits, away_hits, home_errors, away_errors, innings, home_stats, away_stats, finished_at').in('fixture_id', allFids) : Promise.resolve({ data: [] }),
      user ? supabaseAdmin.from('baseball_user_hidden').select('fixture_id').eq('user_id', user.id) : Promise.resolve({ data: [] }),
      user ? supabaseAdmin.from('baseball_user_favorites').select('fixture_id').eq('user_id', user.id) : Promise.resolve({ data: [] }),
    ]);

    const toNum = (v) => Number(v);
    const compactAnalysis = (analysis) => ({
      fixture_id: analysis.fixture_id,
      combinada: analysis.combinada,
      data_quality: analysis.data_quality,
      cache_version: analysis.cache_version,
      best_odds: { moneyline: analysis.best_odds?.moneyline || {} },
      // El listado usa un contrato compacto, pero Veredicto final es parte de
      // la tarjeta. Antes se descartaba aquí y el componente recibía `null`,
      // aunque PostgreSQL sí tenía picks y porcentajes calculados.
      analysis: {
        pitcherMatchup: analysis.analysis?.pitcherMatchup || null,
        finalVerdict: analysis.analysis?.finalVerdict || null,
      },
    });
    const analysisMap = new Map((analysesRes.data || [])
      .filter(a => Number(a.cache_version || 0) >= MULTISPORT_CACHE_VERSION)
      .map(a => [toNum(a.fixture_id), compactAnalysis(a)]));
    const resultsMap = new Map((resultsRes.data || []).map(r => [toNum(r.fixture_id), r]));

    // Los props de jugador también deben poder liquidarse al volver a una
    // jornada finalizada. Cargamos solo los IDs que aparecen en el catálogo
    // Bet365 de esa jornada; no enviamos el boxscore completo de cada roster.
    const requestedPlayersByFixture = new Map();
    for (const analysis of analysisMap.values()) {
      const fixtureId = toNum(analysis.fixture_id);
      const markets = Array.isArray(analysis.combinada?.selectable)
        ? analysis.combinada.selectable
        : [];
      for (const market of markets) {
        const playerId = String(market?.id || '').match(/^player-[a-zA-Z]+-(\d+)-/)?.[1];
        if (!playerId) continue;
        if (!requestedPlayersByFixture.has(fixtureId)) requestedPlayersByFixture.set(fixtureId, new Set());
        requestedPlayersByFixture.get(fixtureId).add(playerId);
      }
    }

    const requestedPlayerIds = [...new Set(
      [...requestedPlayersByFixture.values()].flatMap((ids) => [...ids]),
    )];
    const playerStatsByFixture = new Map();
    if (requestedPlayersByFixture.size && requestedPlayerIds.length) {
      const { data: playerRows, error: playerRowsError } = await supabaseAdmin
        .from('baseball_engine_player_stats')
        .select('fixture_id,player_id,player_name,team_id,stats')
        .in('fixture_id', [...requestedPlayersByFixture.keys()].map(String))
        .in('player_id', requestedPlayerIds);
      if (playerRowsError) throw playerRowsError;
      for (const row of (playerRows || [])) {
        const fixtureId = toNum(row.fixture_id);
        if (!requestedPlayersByFixture.get(fixtureId)?.has(String(row.player_id))) continue;
        if (!playerStatsByFixture.has(fixtureId)) playerStatsByFixture.set(fixtureId, {});
        playerStatsByFixture.get(fixtureId)[String(row.player_id)] = {
          playerName: row.player_name,
          teamId: row.team_id,
          stats: row.stats || {},
        };
      }
    }
    const hiddenSet = new Set((hiddenRes.data || []).map(h => toNum(h.fixture_id)));
    const favoritesSet = new Set((favoritesRes.data || []).map(f => toNum(f.fixture_id)));

    // Nunca pedir al cliente que ejecute el motor. Si el proveedor añadió un
    // juego tarde o un deploy invalidó el contrato anterior, una sola cola
    // idempotente repara las fechas UTC que forman su jornada local. El bucket
    // evita que cien usuarios creen cien jobs mientras la reparación corre.
    const missingCurrentAnalysis = allFids.filter((fixtureId) => !analysisMap.has(fixtureId));
    if (missingCurrentAnalysis.length) {
      const bucket = Math.floor(Date.now() / (15 * 60_000));
      const compactDates = fetchDates.map((value) => value.replaceAll('-', '')).join('-');
      const jobId = `baseball-auto-v${MULTISPORT_CACHE_VERSION}-${compactDates}-${bucket}`;
      const queued = await enqueue(
        'baseball-analyze',
        { coverage: true, dates: fetchDates },
        { jobOpts: { jobId } },
      );
      if (!queued?.ok) console.warn('[api/baseball/fixtures] no se pudo encolar cobertura automática', queued?.error || 'desconocido');
    }

    const enriched = fixtures.map(f => {
      const fid = toNum(f.id);
      const isAnalyzed = analysisMap.has(fid);
      const result = resultsMap.get(fid) || null;
      const playerStats = playerStatsByFixture.get(fid);
      return {
        ...f,
        analysis: analysisMap.get(fid) || null,
        liveResult: result && playerStats ? { ...result, player_stats: playerStats } : result,
        isAnalyzed,
        analysisPending: !isAnalyzed,
        isHidden: hiddenSet.has(fid),
        isFavorite: favoritesSet.has(fid),
      };
    });
    enriched.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    return Response.json({ success: true, date, userTz, fetchedDates: fetchDates, fixtures: enriched, count: enriched.length });
  } catch (e) {
    console.error('[api/baseball/fixtures]', e.message);
    return jsonError(e);
  }
}
