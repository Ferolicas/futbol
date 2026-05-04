/* eslint-disable */
// Rellena las nuevas columnas (actual_total_cards, actual_first_goal_minute,
// actual_goal_minutes, actual_goal_scorers) para los partidos ya finalizados,
// usando match_results.full_data como fuente cruda.
// Idempotente: solo escribe si la columna está NULL o difiere.

require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function getStat(statsObj, name) {
  if (!statsObj?.statistics) return null;
  const stat = statsObj.statistics.find((x) => x.type === name);
  return stat?.value ?? null;
}

function extractFromFull(match) {
  if (!match) return null;
  const homeId = match.teams?.home?.id;
  const awayId = match.teams?.away?.id;
  const homeStats = (match.statistics || []).find((s) => s.team?.id === homeId);
  const awayStats = (match.statistics || []).find((s) => s.team?.id === awayId);

  const yh = getStat(homeStats, 'Yellow Cards');
  const ya = getStat(awayStats, 'Yellow Cards');
  const rh = getStat(homeStats, 'Red Cards');
  const ra = getStat(awayStats, 'Red Cards');
  const cardEvents = (match.events || []).filter((e) => e.type === 'Card');
  const fromStats = [yh, ya, rh, ra].some((v) => v != null);
  const totalCards = fromStats
    ? (yh || 0) + (ya || 0) + (rh || 0) + (ra || 0)
    : cardEvents.length;

  const goalEvents = (match.events || []).filter(
    (e) => e.type === 'Goal' && e.detail !== 'Missed Penalty'
  );
  const goalMinutes = goalEvents
    .map((e) =>
      e.time?.elapsed != null ? e.time.elapsed + (e.time.extra || 0) : null
    )
    .filter((m) => m != null)
    .sort((a, b) => a - b);
  const firstGoalMinute = goalMinutes[0] ?? null;

  const goalScorers = goalEvents.map((e) => ({
    player_id: e.player?.id ?? null,
    name: e.player?.name ?? null,
    team_id: e.team?.id ?? null,
    minute:
      e.time?.elapsed != null ? e.time.elapsed + (e.time.extra || 0) : null,
    detail: e.detail || null,
  }));

  return { totalCards, firstGoalMinute, goalMinutes, goalScorers };
}

(async () => {
  // Solo predicciones finalizadas y a las que les falta al menos uno de los nuevos campos
  const { data: preds, error } = await s
    .from('match_predictions')
    .select('fixture_id, actual_total_cards, actual_first_goal_minute, actual_goal_minutes, actual_goal_scorers')
    .not('finalized_at', 'is', null);
  if (error) { console.error(error.message); process.exit(1); }

  console.log(`Finalizadas: ${preds.length}`);
  const needBackfill = preds.filter(
    (p) =>
      p.actual_total_cards == null ||
      p.actual_first_goal_minute === undefined ||
      (p.actual_goal_minutes == null && p.actual_first_goal_minute == null)
  );
  console.log(`Necesitan backfill: ${needBackfill.length}`);

  if (needBackfill.length === 0) {
    console.log('Nada que hacer.');
    return;
  }

  const fids = needBackfill.map((p) => p.fixture_id);

  // Trae match_results.full_data en lotes
  const BATCH = 200;
  const fullByFid = new Map();
  for (let i = 0; i < fids.length; i += BATCH) {
    const slice = fids.slice(i, i + BATCH);
    const { data: results, error: e2 } = await s
      .from('match_results')
      .select('fixture_id, full_data')
      .in('fixture_id', slice);
    if (e2) { console.error(e2.message); process.exit(1); }
    for (const r of results || []) fullByFid.set(r.fixture_id, r.full_data);
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  for (const p of needBackfill) {
    const full = fullByFid.get(p.fixture_id);
    if (!full) { skipped++; continue; }
    const ex = extractFromFull(full);
    if (!ex) { skipped++; continue; }

    const update = {};
    if (p.actual_total_cards == null) update.actual_total_cards = ex.totalCards ?? null;
    if (p.actual_first_goal_minute == null) update.actual_first_goal_minute = ex.firstGoalMinute ?? null;
    if (p.actual_goal_minutes == null && ex.goalMinutes.length) update.actual_goal_minutes = ex.goalMinutes;
    if (p.actual_goal_scorers == null && ex.goalScorers.length) update.actual_goal_scorers = ex.goalScorers;

    if (Object.keys(update).length === 0) { skipped++; continue; }

    const { error: e3 } = await s
      .from('match_predictions')
      .update(update)
      .eq('fixture_id', p.fixture_id);
    if (e3) { failed++; console.error(`  fid=${p.fixture_id}: ${e3.message}`); }
    else { updated++; }
    if (updated % 50 === 0 && updated > 0) console.log(`  ${updated} actualizados...`);
  }

  console.log(`\nResumen: actualizados=${updated} omitidos=${skipped} fallidos=${failed}`);
})();
