/* eslint-disable */
// Mide la efectividad de los goleadores predichos:
// para cada match_prediction finalizada con `predicted_scorers`, contamos
// cuántos de los top-N predichos efectivamente marcaron en el partido real.
// Como goleadores específicos son cola larga, no se calibra por bucket;
// reportamos hit-rate agregado por posición en el ranking.

require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

(async () => {
  const { data: rows, error } = await s
    .from('match_predictions')
    .select('fixture_id, predicted_scorers, actual_goal_scorers')
    .not('finalized_at', 'is', null)
    .not('predicted_scorers', 'is', null)
    .not('actual_goal_scorers', 'is', null);
  if (error) { console.error(error.message); process.exit(1); }

  console.log(`\nMuestras con goleadores predichos + reales: ${rows.length}`);
  if (rows.length === 0) {
    console.log('Sin datos. Ejecuta el backfill o espera a que se acumulen partidos analizados.');
    return;
  }

  // Hit-rate por posición en el ranking (top1, top2, top3, ...)
  const byRank = {};
  // Calibración agregada por bucket de probabilidad (todos los predichos juntos)
  const buckets = {};

  let totalPredicted = 0;
  let totalHit = 0;

  for (const r of rows) {
    const actualIds = new Set(
      (r.actual_goal_scorers || []).map(g => g.player_id).filter(Boolean)
    );
    (r.predicted_scorers || []).forEach((p, idx) => {
      totalPredicted++;
      const hit = actualIds.has(p.id) ? 1 : 0;
      totalHit += hit;

      const rank = `top${idx + 1}`;
      if (!byRank[rank]) byRank[rank] = { n: 0, hit: 0, sumProb: 0 };
      byRank[rank].n++;
      byRank[rank].hit += hit;
      byRank[rank].sumProb += p.prob_pct || 0;

      const b = Math.min(9, Math.floor((p.prob_pct || 0) / 10));
      const bk = `${b * 10}-${b * 10 + 10}%`;
      if (!buckets[bk]) buckets[bk] = { n: 0, hit: 0, sumProb: 0 };
      buckets[bk].n++;
      buckets[bk].hit += hit;
      buckets[bk].sumProb += p.prob_pct || 0;
    });
  }

  console.log('\n## Hit-rate por posición en el ranking');
  console.table(
    Object.entries(byRank)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([rank, b]) => ({
        rank,
        predicciones: b.n,
        hits: b.hit,
        hit_rate: ((b.hit / b.n) * 100).toFixed(1) + '%',
        prob_predicha_avg: (b.sumProb / b.n).toFixed(1) + '%',
        sesgo: (((b.hit / b.n) * 100 - b.sumProb / b.n) > 0 ? '+' : '') +
               (((b.hit / b.n) * 100) - b.sumProb / b.n).toFixed(1) + ' pp',
      }))
  );

  console.log('\n## Calibración agregada (todos los goleadores juntos por bucket)');
  console.table(
    Object.entries(buckets)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([bk, b]) => ({
        bucket: bk,
        n: b.n,
        prob_avg: (b.sumProb / b.n).toFixed(1) + '%',
        hit_rate: ((b.hit / b.n) * 100).toFixed(1) + '%',
        diff: (((b.hit / b.n) * 100 - b.sumProb / b.n) > 0 ? '+' : '') +
              (((b.hit / b.n) * 100) - b.sumProb / b.n).toFixed(1) + ' pp',
      }))
  );

  console.log(`\nGlobal: ${totalHit}/${totalPredicted} aciertos = ${((totalHit / totalPredicted) * 100).toFixed(1)}%`);
})();
