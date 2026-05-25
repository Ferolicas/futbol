// @ts-nocheck
/**
 * Job: baseball-finalize
 *
 * Rellena los actual_* de baseball_match_predictions para los partidos ya
 * terminados, y marca finalized_at. La calibración (baseball-calibrate) solo
 * usa predicciones con finalized_at NO nulo, así que sin este job nunca hay
 * datos para calibrar.
 *
 * DOS PASES (mismo patrón que futbol-finalize):
 *
 *   Pass 1 — local (sin API): cruza contra baseball_match_results y finaliza
 *            las que ya tengan estado terminal (FT/AOT) con marcador.
 *
 *   Pass 2 — fallback API: para las predicciones que siguen pendientes (su
 *            resultado local no existe o NO está terminado), trae el resultado
 *            final de la API agrupando por FECHA — `getBaseballFixturesByDate`
 *            devuelve TODOS los games de un día en 1 sola llamada, incluidos
 *            los terminados. Con forceApi:true salta el cache (el snapshot
 *            matutino tiene status NS, sin el FT/AOT que necesitamos), escribe
 *            el resultado final en baseball_match_results (lo deja cacheado) y
 *            finaliza la predicción.
 *
 * POR QUÉ EL PASS 2 ES IMPRESCINDIBLE:
 *   baseball_match_results SOLO lo escribe el job live, y getBaseballLiveGames
 *   filtra los estados terminales — en cuanto un game termina deja de aparecer
 *   en el live, así que su FT/AOT NUNCA se persiste. Resultado: la tabla de
 *   resultados se queda con el último estado EN JUEGO (IN9, etc.) y el Pass 1
 *   por sí solo no finaliza nada. El Pass 2 con API es el que realmente cierra
 *   el ciclo.
 *
 * Ventana: 3 días hacia atrás por defecto. El plan GRATUITO de api-baseball
 * SOLO permite consultar los últimos 3 días — pedir fechas más antiguas la API
 * las rechaza, así que no tiene sentido ampliar la ventana. Para un backfill
 * puntual con plan de pago se puede pasar { days: N } explícito.
 *
 * Cuota: api-baseball gratuito da 100 calls/día. Agrupar por fecha hace que el
 * finalize cueste ~1 call por día con predicciones pendientes (no por partido):
 * con ventana de 3 días son ~3 calls como máximo. Guard de cuota antes de cada
 * fetch para nunca pasarnos del presupuesto.
 *
 * Payload: { days?: number }  (override de la ventana, default 3)
 */
import { supabaseAdmin, getBaseballFixturesByDate, getBaseballQuota } from '../../shared.js';
import { mapPool } from '../../pool.js';

const FINISHED = new Set(['FT', 'AOT', 'POST', 'CANC', 'INTR', 'ABD']);
const TERMINAL_SCORED = new Set(['FT', 'AOT']); // solo estos tienen marcador real
const DEFAULT_WINDOW_DAYS = 3;
const QUOTA_SAFETY_RESERVE = 5;

function sumF5(innings) {
  if (!innings) return null;
  if (Array.isArray(innings)) {
    return innings.slice(0, 5).reduce((s, i) => s + (Number(i?.score ?? i) || 0), 0);
  }
  if (typeof innings === 'object') {
    let total = 0;
    for (let i = 1; i <= 5; i++) {
      const v = innings[i] ?? innings[String(i)];
      if (v != null) total += Number(v) || 0;
    }
    return total;
  }
  return null;
}

// Construye el objeto de actuals desde un marcador final (home/away + innings).
function buildActuals(homeScore, awayScore, innings, status) {
  const f5Home = sumF5(innings?.home || innings);
  const f5Away = sumF5(innings?.away || innings);
  const f5Total = f5Home != null && f5Away != null ? f5Home + f5Away : null;
  return {
    actual_home_score: homeScore,
    actual_away_score: awayScore,
    actual_total_runs: homeScore + awayScore,
    actual_run_diff: homeScore - awayScore,
    actual_result: homeScore > awayScore ? 'H' : 'A',
    actual_f5_home_score: f5Home,
    actual_f5_away_score: f5Away,
    actual_f5_total: f5Total,
    actual_btts: homeScore > 0 && awayScore > 0,
    actual_status: status,
    finalized_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export async function runBaseballFinalize(payload = {}) {
  const windowDays = Number(payload.days) > 0 ? Number(payload.days) : DEFAULT_WINDOW_DAYS;
  const since = new Date();
  since.setDate(since.getDate() - windowDays);
  const sinceStr = since.toISOString().split('T')[0];
  const todayStr = new Date().toISOString().split('T')[0];

  const { data: predictions, error } = await supabaseAdmin
    .from('baseball_match_predictions')
    .select('fixture_id, date')
    .gte('date', sinceStr)
    .is('finalized_at', null);

  if (error) throw error;
  if (!predictions || predictions.length === 0) {
    return { ok: true, finalized: 0, message: 'no pending predictions', windowDays };
  }

  // No tiene sentido buscar resultado de partidos que aún no ocurrieron.
  // (date < hoy → ya jugados; date === hoy → posiblemente en juego, los
  // tratamos también porque pueden haber terminado.)
  const pending = predictions.filter(p => p.date <= todayStr);

  const ids = pending.map(p => p.fixture_id);
  const { data: results } = await supabaseAdmin
    .from('baseball_match_results')
    .select('*')
    .in('fixture_id', ids);
  const resultsMap = new Map((results || []).map(r => [Number(r.fixture_id), r]));

  let finalizedP1 = 0, finalizedP2 = 0, skipped = 0, apiCalls = 0;
  const errors = [];

  // ── PASS 1 — local (sin API). Finaliza las que ya tengan FT/AOT con marcador.
  const stillPending = [];
  const p1 = await mapPool(pending, 10, async (pred) => {
    const r = resultsMap.get(Number(pred.fixture_id));
    if (!r || !TERMINAL_SCORED.has(r.status) || r.home_score == null || r.away_score == null) {
      return { fid: pred.fixture_id, pred, status: 'pending' };
    }
    const { error: updErr } = await supabaseAdmin
      .from('baseball_match_predictions')
      .update(buildActuals(r.home_score, r.away_score, r.innings, r.status))
      .eq('fixture_id', pred.fixture_id);
    if (updErr) throw new Error(`P1 update: ${updErr.message || updErr}`);
    return { fid: pred.fixture_id, status: 'finalized' };
  });
  p1.forEach((res, idx) => {
    if (!res.ok) {
      errors.push({ pass: 1, fixtureId: pending[idx].fixture_id, error: res.error.message });
      console.error(`[job:baseball-finalize P1] fixture ${pending[idx].fixture_id}:`, res.error.message);
    } else if (res.value.status === 'finalized') finalizedP1++;
    else stillPending.push(res.value.pred);
  });

  // ── PASS 2 — fallback API agrupando por fecha. Trae el resultado FINAL.
  if (stillPending.length > 0) {
    // Agrupar pendientes por fecha → 1 fetch por día (no por partido).
    const byDate = {};
    for (const p of stillPending) {
      (byDate[p.date] = byDate[p.date] || new Set()).add(Number(p.fixture_id));
    }
    const dates = Object.keys(byDate).sort(); // más antiguas primero

    for (const date of dates) {
      const quota = await getBaseballQuota();
      if (quota.remaining <= QUOTA_SAFETY_RESERVE) {
        console.warn(`[job:baseball-finalize P2] cuota baja (${quota.remaining}) — paro en fecha ${date}, reanudará mañana`);
        break;
      }

      let games;
      try {
        // forceApi: el cache matutino tiene status NS; necesitamos el estado
        // ACTUAL (FT/AOT) que solo da una llamada fresca.
        const res = await getBaseballFixturesByDate(date, { forceApi: true });
        games = res.fixtures || [];
        apiCalls++;
      } catch (e) {
        console.error(`[job:baseball-finalize P2] fetch ${date}:`, e.message);
        errors.push({ pass: 2, date, error: e.message });
        if (String(e.message).includes('QUOTA_EXHAUSTED')) break;
        continue;
      }

      const gamesById = new Map(games.map(g => [Number(g.id), g]));
      const wantedFids = byDate[date];

      const p2 = await mapPool([...wantedFids], 10, async (fid) => {
        const g = gamesById.get(fid);
        if (!g) return { fid, status: 'no-game' };
        const status = g.status?.short;
        if (!TERMINAL_SCORED.has(status)) return { fid, status: 'not-finished' };
        const homeScore = g.scores?.home?.total;
        const awayScore = g.scores?.away?.total;
        if (homeScore == null || awayScore == null) return { fid, status: 'no-score' };
        const innings = g.scores?.home?.innings || g.innings || null;

        // 1) Persistir el resultado final en baseball_match_results (cache +
        //    deja la fila con FT/AOT correcto, que el live nunca escribió).
        const { error: resErr } = await supabaseAdmin.from('baseball_match_results').upsert({
          fixture_id: fid,
          league_id: g.league?.id,
          date,
          status,
          inning: g.status?.inning ?? null,
          home_score: homeScore,
          away_score: awayScore,
          home_hits: g.scores?.home?.hits ?? null,
          away_hits: g.scores?.away?.hits ?? null,
          home_errors: g.scores?.home?.errors ?? null,
          away_errors: g.scores?.away?.errors ?? null,
          innings,
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        if (resErr) throw new Error(`P2 upsert result: ${resErr.message || resErr}`);

        // 2) Finalizar la predicción.
        const { error: updErr } = await supabaseAdmin
          .from('baseball_match_predictions')
          .update(buildActuals(homeScore, awayScore, innings, status))
          .eq('fixture_id', fid);
        if (updErr) throw new Error(`P2 update pred: ${updErr.message || updErr}`);
        return { fid, status: 'finalized' };
      });

      const wantedArr = [...wantedFids];
      p2.forEach((res, idx) => {
        if (!res.ok) {
          errors.push({ pass: 2, fixtureId: wantedArr[idx], error: res.error.message });
          console.error(`[job:baseball-finalize P2] fixture ${wantedArr[idx]}:`, res.error.message);
        } else if (res.value.status === 'finalized') finalizedP2++;
        else skipped++;
      });
    }
  }

  const finalized = finalizedP1 + finalizedP2;
  console.log(`[job:baseball-finalize] window=${windowDays}d pending=${pending.length} P1=${finalizedP1} P2=${finalizedP2} skipped=${skipped} apiCalls=${apiCalls} errors=${errors.length}`);

  // No lanzamos si hay errores parciales — un game sin resultado todavía no es
  // un fallo del job; finalizamos lo que se pueda y el resto reintenta mañana.
  return {
    ok: true,
    windowDays,
    examined: pending.length,
    finalized,
    finalizedP1,
    finalizedP2,
    skipped,
    apiCalls,
    errors: errors.length,
  };
}
