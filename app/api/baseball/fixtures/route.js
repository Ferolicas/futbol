/**
 * GET /api/baseball/fixtures?date=YYYY-MM-DD&tz=<IANA>
 *
 * Devuelve los partidos de baseball para `date` en la zona horaria del
 * cliente, igual que /api/fixtures (fútbol):
 *
 *   - Pide a la API la fecha UTC + días adyacentes (ayer/hoy/mañana) para
 *     cubrir partidos que cruzan medianoche en la TZ del usuario.
 *   - Filtra a los que su kickoff cae en el día local `date` del usuario.
 *   - Cross-midnight live: si la vista es de "hoy/futuro", incluye games
 *     en juego que arrancaron ayer (UTC) y siguen vivos. Cuando finalizan,
 *     vuelven a su fecha real.
 *
 * Source: 100% PG VPS (vía supabaseAdmin = pgAdmin proxy, no Supabase real).
 */
import { getBaseballFixturesByDate } from '../../../../lib/api-baseball';
import { supabaseAdmin } from '../../../../lib/supabase';
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';

export const dynamic = 'force-dynamic';

const FINISHED_STATUSES = new Set(['FT', 'AOT', 'POST', 'CANC', 'INT', 'ABD']);
const LIVE_STATUSES     = new Set(['IN', 'LIVE', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'BT', 'BBT', 'EXT']);

// Convierte una fecha ISO UTC al string 'YYYY-MM-DD' del día local en `tz`.
// Mismo principio que lib/timezone.js#getLocalDateForFixture pero adaptado
// al shape de baseball (game.date es ISO plano, no game.fixture.date).
function localDateOf(utcIso, tz) {
  if (!utcIso) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(utcIso));
  } catch {
    return utcIso.split('T')[0];
  }
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const userTz = searchParams.get('tz') || 'UTC';
    const todayUtc = new Date().toISOString().split('T')[0];
    const date = searchParams.get('date') || todayUtc;
    const isPast = date < todayUtc;

    // Auth (anónimo puede ver fixtures; hidden/favorites requieren user).
    const supabase = createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();

    // Para usuarios con TZ ≠ UTC, un día local cubre 2 días UTC. Si el usuario
    // mira "hoy local" pero algunos games arrancan a las 19:00 ET (= 00:00 UTC
    // del día siguiente), tenemos que pedir esos también. Pedimos las 3 fechas
    // UTC adyacentes y luego filtramos por día local del usuario.
    const d = new Date(date + 'T12:00:00Z');
    const prevDay = new Date(d.getTime() - 86400000).toISOString().split('T')[0];
    const nextDay = new Date(d.getTime() + 86400000).toISOString().split('T')[0];
    const fetchDates = userTz !== 'UTC' ? [prevDay, date, nextDay] : [date];

    // Pedir las 3 fechas en paralelo a la fuente (getBaseballFixturesByDate
    // ya hace cache Redis+PG, así que pedir 3 es barato).
    const fixturesByDate = await Promise.all(
      fetchDates.map(d => getBaseballFixturesByDate(d).catch(() => ({ fixtures: [] }))),
    );
    const rawFixtures = fixturesByDate.flatMap(r => r.fixtures || []);
    // Dedupe por id (un mismo game podría aparecer en 2 fetches en bordes raros).
    const seen = new Set();
    const merged = [];
    for (const f of rawFixtures) {
      if (!f?.id || seen.has(f.id)) continue;
      seen.add(f.id);
      merged.push(f);
    }

    // Filtrar al día local del usuario: el kickoff en su TZ cae en `date`.
    let fixtures = merged.filter(f => localDateOf(f.date, userTz) === date);

    // Cross-midnight live: si la vista es de hoy/futuro y hay games que
    // arrancaron en otro día pero siguen IN PLAY, los traemos también.
    // Cuando finalicen (status FT/AOT/etc.), dejan de aparecer aquí y
    // vuelven a su fecha real. Sin esto, un game de las 23:00 ET que
    // pasa a 00:00 UTC desaparece de la vista a medianoche.
    if (!isPast) {
      const fidsIn = new Set(fixtures.map(f => Number(f.id)));
      for (const f of merged) {
        const st = f.status?.short || f.status?.long;
        const liveNow = LIVE_STATUSES.has(st);
        if (liveNow && !fidsIn.has(Number(f.id))) {
          fixtures.push(f);
          fidsIn.add(Number(f.id));
        }
      }
    }

    // Cargar análisis/resultados/hidden/favorites en paralelo. Como ahora
    // fixtures puede venir de varias fechas, consultamos por fixture_id IN
    // (no por date) — es lo correcto cuando hay cross-midnight.
    const allFids = fixtures.map(f => Number(f.id));
    const [analysesRes, resultsRes, hiddenRes, favoritesRes] = await Promise.all([
      allFids.length > 0
        ? supabaseAdmin
            .from('baseball_match_analysis')
            .select('fixture_id, probabilities, combinada, data_quality, best_odds')
            .in('fixture_id', allFids)
        : Promise.resolve({ data: [] }),
      allFids.length > 0
        ? supabaseAdmin
            .from('baseball_match_results')
            .select('fixture_id, status, inning, inning_half, home_score, away_score, home_hits, away_hits, home_errors, away_errors')
            .in('fixture_id', allFids)
        : Promise.resolve({ data: [] }),
      user
        ? supabaseAdmin.from('baseball_user_hidden').select('fixture_id, date').eq('user_id', user.id)
        : Promise.resolve({ data: [] }),
      user
        ? supabaseAdmin.from('baseball_user_favorites').select('fixture_id').eq('user_id', user.id)
        : Promise.resolve({ data: [] }),
    ]);

    const toNum = (v) => Number(v);
    const analysisMap = new Map((analysesRes.data || []).map(a => [toNum(a.fixture_id), a]));
    const resultsMap  = new Map((resultsRes.data  || []).map(r => [toNum(r.fixture_id), r]));
    // hidden ahora se compara solo por fixture_id (no por date) — si el
    // usuario ocultó el game, no lo quiere ver hoy, ayer ni mañana.
    const hiddenSet   = new Set((hiddenRes.data   || []).map(h => toNum(h.fixture_id)));
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

    // Ordenar por hora de inicio ascendente (más cercanos primero).
    enriched.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    return Response.json({
      success: true,
      date,
      userTz,
      fetchedDates: fetchDates,
      fixtures: enriched,
      count: enriched.length,
    });
  } catch (e) {
    console.error('[api/baseball/fixtures]', e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
