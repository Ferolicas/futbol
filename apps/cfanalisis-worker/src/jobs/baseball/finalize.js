// @ts-nocheck
/**
 * Job: baseball-finalize (MLB-only, MLB Stats API)
 *
 * Rellena los actual_* de baseball_match_predictions para los juegos MLB ya
 * terminados y marca finalized_at. La calibración (baseball-calibrate) solo usa
 * predicciones finalizadas, así que sin este job no hay datos para calibrar.
 *
 * MLB Stats API da el resultado FINAL directo en /schedule?hydrate=linescore
 * (con marcador + line score por entrada para F5), sin límite de fechas (a
 * diferencia de api-baseball free, 2022-2024). Por eso esto es 1 sola llamada
 * por fecha pendiente, sin los 2 pases que api-baseball obligaba.
 *
 * Ventana: 7 días hacia atrás por defecto (recupera pendientes con holgura).
 *
 * Payload: { days?: number, sportId?: 1|11|12 }
 */
import { supabaseAdmin, getMlbResultsByDate } from '../../shared.js';
import { mapPool } from '../../pool.js';

const DEFAULT_WINDOW_DAYS = 7;
const SPORT_IDS = [1];

function buildActuals(r) {
  return {
    actual_home_score: r.home.score,
    actual_away_score: r.away.score,
    actual_total_runs: r.totalRuns,
    actual_run_diff: r.runDiff,
    actual_result: r.result, // 'H' | 'A'
    actual_f5_home_score: r.f5Home,
    actual_f5_away_score: r.f5Away,
    actual_f5_total: r.f5Total,
    actual_btts: r.btts,
    actual_status: 'Final',
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

  const pending = (predictions || []).filter(p => p.date <= todayStr);
  if (pending.length === 0) {
    return { ok: true, finalized: 0, message: 'no pending predictions', windowDays };
  }

  // Agrupar por fecha → 1 llamada a MLB Stats API por día.
  const byDate = {};
  for (const p of pending) {
    (byDate[p.date] = byDate[p.date] || new Set()).add(Number(p.fixture_id));
  }
  const dates = Object.keys(byDate).sort();

  let finalized = 0, notFinal = 0, noGame = 0, apiCalls = 0;
  const errors = [];

  for (const date of dates) {
    // Resultados finales de todos los sportIds de esa fecha.
    const resultsById = new Map();
    for (const sportId of SPORT_IDS) {
      try {
        const results = await getMlbResultsByDate(date, sportId);
        apiCalls++;
        for (const r of results) resultsById.set(Number(r.gamePk), r);
      } catch (e) {
        console.error(`[baseball-finalize] fetch ${date} sportId=${sportId}: ${e.message}`);
        errors.push({ date, sportId, error: e.message });
      }
    }

    const wanted = [...byDate[date]];
    const res = await mapPool(wanted, 10, async (fid) => {
      const r = resultsById.get(fid);
      if (!r) return { fid, status: 'no-game' };          // aún no en resultados / no final
      if (r.result == null) return { fid, status: 'not-final' };
      const { error: updErr } = await supabaseAdmin
        .from('baseball_match_predictions')
        .update(buildActuals(r))
        .eq('fixture_id', fid);
      if (updErr) throw new Error(`update ${fid}: ${updErr.message || updErr}`);
      return { fid, status: 'finalized' };
    });

    res.forEach((rr, idx) => {
      if (!rr.ok) { errors.push({ date, fixtureId: wanted[idx], error: rr.error.message }); }
      else if (rr.value.status === 'finalized') finalized++;
      else if (rr.value.status === 'no-game') noGame++;
      else notFinal++;
    });
  }

  console.log(`[baseball-finalize] window=${windowDays}d pending=${pending.length} finalized=${finalized} notFinal=${notFinal} noGame=${noGame} apiCalls=${apiCalls} errors=${errors.length}`);
  return { ok: true, windowDays, examined: pending.length, finalized, notFinal, noGame, apiCalls, errors: errors.length };
}
