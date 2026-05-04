/* eslint-disable */
// Backfill de las nuevas columnas de PREDICCIONES (no de actuals):
//   - p_cards_over_25 / 35 / 45  → desde cornerCardData de match_analysis
//   - p_first_goal_30 / 45        → desde lambda_home + lambda_away (Poisson)
// Necesario para que las 600 predicciones viejas tengan datos predichos
// y entren en la calibración de los nuevos mercados.

require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function poissonCDF(k, λ) {
  let sum = 0, term = Math.exp(-λ);
  for (let i = 0; i <= k; i++) {
    sum += term;
    term *= λ / (i + 1);
  }
  return sum;
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function cardsProbs(avgTotal) {
  const λ = avgTotal > 0 ? avgTotal : 3.8;
  return {
    over25: clamp(Math.round((1 - poissonCDF(2, λ)) * 100), 5, 95),
    over35: clamp(Math.round((1 - poissonCDF(3, λ)) * 100), 5, 95),
    over45: clamp(Math.round((1 - poissonCDF(4, λ)) * 100), 5, 95),
  };
}

function firstGoalProbs(λH, λA) {
  const λ = (λH || 0) + (λA || 0);
  if (λ <= 0) return { before30: 5, before45: 5 };
  const p = (t) => 1 - Math.exp(-λ * (t / 90));
  return {
    before30: clamp(Math.round(p(30) * 100), 5, 95),
    before45: clamp(Math.round(p(45) * 100), 5, 95),
  };
}

function deriveCardAvg(ccd) {
  if (!ccd) return null;
  if (ccd.totalCardsAvg > 0) return ccd.totalCardsAvg;
  const h = Array.isArray(ccd.homeCardsPerMatch) && ccd.homeCardsPerMatch.length
    ? ccd.homeCardsPerMatch.reduce((a, b) => a + (b || 0), 0) / ccd.homeCardsPerMatch.length
    : null;
  const a = Array.isArray(ccd.awayCardsPerMatch) && ccd.awayCardsPerMatch.length
    ? ccd.awayCardsPerMatch.reduce((x, y) => x + (y || 0), 0) / ccd.awayCardsPerMatch.length
    : null;
  if (h != null && a != null) return h + a;
  if ((ccd.homeYellowsAvg || 0) + (ccd.awayYellowsAvg || 0) > 0) {
    return (ccd.homeYellowsAvg || 0) + (ccd.awayYellowsAvg || 0);
  }
  return null;
}

(async () => {
  const { data: preds, error } = await s
    .from('match_predictions')
    .select('fixture_id, lambda_home, lambda_away, p_cards_over_25, p_first_goal_30')
    .not('finalized_at', 'is', null);
  if (error) { console.error(error.message); process.exit(1); }

  console.log(`Finalizadas: ${preds.length}`);
  const need = preds.filter(p => p.p_cards_over_25 == null || p.p_first_goal_30 == null);
  console.log(`Necesitan backfill de predicciones: ${need.length}`);
  if (need.length === 0) return;

  const fids = need.map(p => p.fixture_id);
  const BATCH = 200;
  const ccdByFid = new Map();
  for (let i = 0; i < fids.length; i += BATCH) {
    const slice = fids.slice(i, i + BATCH);
    const { data: rows, error: e2 } = await s
      .from('match_analysis')
      .select('fixture_id, analysis')
      .in('fixture_id', slice);
    if (e2) { console.error(e2.message); process.exit(1); }
    for (const r of rows || []) {
      const ccd = r.analysis?.analysis?.cornerCardData;
      ccdByFid.set(r.fixture_id, ccd || null);
    }
  }

  let updated = 0, skipped = 0, failed = 0;
  for (const p of need) {
    const update = {};
    if (p.p_cards_over_25 == null) {
      const ccd = ccdByFid.get(p.fixture_id);
      const cardAvg = deriveCardAvg(ccd) ?? 3.8;
      const cp = cardsProbs(cardAvg);
      update.p_cards_over_25 = cp.over25;
      update.p_cards_over_35 = cp.over35;
      update.p_cards_over_45 = cp.over45;
    }
    if (p.p_first_goal_30 == null && p.lambda_home != null && p.lambda_away != null) {
      const fg = firstGoalProbs(p.lambda_home, p.lambda_away);
      update.p_first_goal_30 = fg.before30;
      update.p_first_goal_45 = fg.before45;
    }
    if (Object.keys(update).length === 0) { skipped++; continue; }

    const { error: e3 } = await s
      .from('match_predictions')
      .update(update)
      .eq('fixture_id', p.fixture_id);
    if (e3) { failed++; console.error(`fid=${p.fixture_id}: ${e3.message}`); }
    else { updated++; }
    if (updated % 100 === 0 && updated > 0) console.log(`  ${updated} actualizados...`);
  }

  console.log(`\nResumen: actualizados=${updated} omitidos=${skipped} fallidos=${failed}`);
})();
