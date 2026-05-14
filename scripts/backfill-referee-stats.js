/* eslint-disable */
/**
 * Backfill de referee_stats desde match_results.
 *
 * Recorre todos los match_results, extrae el arbitro de full_data.fixture.referee
 * y agrega yellows/reds. Reemplaza la fila por arbitro con los totales calculados.
 *
 * USO:
 *   node scripts/backfill-referee-stats.js              # aborta si la tabla no esta vacia
 *   node scripts/backfill-referee-stats.js --force      # borra y recalcula desde cero
 *   node scripts/backfill-referee-stats.js --dry-run    # imprime resumen sin escribir
 *
 * Pre-requisito: haber corrido scripts/migrate-referee-stats.sql en Supabase.
 */

require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('[backfill-referee-stats] faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env.local');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const FORCE   = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');
const PAGE_SIZE = 1000;

function normalizeRefereeName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.split(',')[0]?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

async function checkPreconditions() {
  const { count, error } = await supabase
    .from('referee_stats')
    .select('id', { count: 'exact', head: true });
  if (error) {
    console.error('[backfill-referee-stats] no se pudo leer referee_stats (corrio la migracion?):', error.message);
    process.exit(1);
  }
  if (count > 0 && !FORCE && !DRY_RUN) {
    console.error(`[backfill-referee-stats] referee_stats ya tiene ${count} filas.`);
    console.error('  Re-corre con --force para borrarlas y recalcular desde cero,');
    console.error('  o con --dry-run para ver que escribiria sin tocar nada.');
    process.exit(1);
  }
}

async function aggregateFromMatchResults() {
  const aggregator = new Map(); // name -> { matches, yellows, reds, lastDate }
  let from = 0;
  let scanned = 0;
  let skippedNoReferee = 0;
  let skippedNoCards = 0;

  while (true) {
    const { data, error } = await supabase
      .from('match_results')
      .select('date, yellow_cards, red_cards, full_data')
      .order('date', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`match_results query: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) {
      scanned++;
      const refRaw = row.full_data?.fixture?.referee;
      const name = normalizeRefereeName(refRaw);
      if (!name) { skippedNoReferee++; continue; }

      const yc = row.yellow_cards || {};
      const rc = row.red_cards || {};
      const yellows = (yc.home || 0) + (yc.away || 0);
      const reds    = (rc.home || 0) + (rc.away || 0);

      // Si no hay datos de tarjetas en absoluto, no contamos el partido
      // para el arbitro — coherente con la regla del finalize.js
      if (yellows === 0 && reds === 0 && yc.home == null && yc.away == null) {
        skippedNoCards++;
        continue;
      }

      const acc = aggregator.get(name) || { matches: 0, yellows: 0, reds: 0, lastDate: null };
      acc.matches  += 1;
      acc.yellows  += yellows;
      acc.reds     += reds;
      if (!acc.lastDate || row.date > acc.lastDate) acc.lastDate = row.date;
      aggregator.set(name, acc);
    }

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
    process.stdout.write(`\r[backfill] escaneados ${scanned}…`);
  }
  process.stdout.write('\n');

  return { aggregator, scanned, skippedNoReferee, skippedNoCards };
}

async function writeAggregates(aggregator) {
  if (FORCE) {
    console.log('[backfill] --force: borrando referee_stats…');
    const { error } = await supabase.from('referee_stats').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) throw new Error(`delete: ${error.message}`);
  }

  const rows = Array.from(aggregator.entries()).map(([name, acc]) => ({
    name,
    matches:        acc.matches,
    total_yellows:  acc.yellows,
    total_reds:     acc.reds,
    total_cards:    acc.yellows + acc.reds,
    last_match_date: acc.lastDate,
  }));

  // Insertar en chunks de 500 para no exceder limites de payload
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from('referee_stats').insert(chunk);
    if (error) throw new Error(`insert chunk @${i}: ${error.message}`);
    written += chunk.length;
    process.stdout.write(`\r[backfill] insertados ${written}/${rows.length}…`);
  }
  process.stdout.write('\n');
  return written;
}

(async () => {
  console.log(`[backfill-referee-stats] start (force=${FORCE}, dry-run=${DRY_RUN})`);
  await checkPreconditions();

  const t0 = Date.now();
  const { aggregator, scanned, skippedNoReferee, skippedNoCards } = await aggregateFromMatchResults();
  const t1 = Date.now();

  console.log(`[backfill] match_results escaneados: ${scanned}`);
  console.log(`[backfill]   sin arbitro: ${skippedNoReferee}`);
  console.log(`[backfill]   sin datos de tarjetas: ${skippedNoCards}`);
  console.log(`[backfill] arbitros agregados: ${aggregator.size}`);

  // Top 5 por matches para sanity check
  const top = Array.from(aggregator.entries())
    .sort((a, b) => b[1].matches - a[1].matches)
    .slice(0, 5);
  console.log('[backfill] top 5 por partidos:');
  for (const [name, acc] of top) {
    const avg = acc.matches > 0 ? ((acc.yellows + acc.reds) / acc.matches).toFixed(2) : '0';
    console.log(`           ${name.padEnd(30)} matches=${acc.matches}  avg_cards=${avg}`);
  }

  if (DRY_RUN) {
    console.log(`[backfill] DRY-RUN: nada escrito. (${((t1 - t0) / 1000).toFixed(1)}s)`);
    return;
  }

  const written = await writeAggregates(aggregator);
  const t2 = Date.now();
  console.log(`[backfill] OK — ${written} arbitros escritos en ${((t2 - t1) / 1000).toFixed(1)}s (scan ${((t1 - t0) / 1000).toFixed(1)}s)`);
})().catch(e => {
  console.error('[backfill-referee-stats] FATAL:', e.message);
  process.exit(1);
});
