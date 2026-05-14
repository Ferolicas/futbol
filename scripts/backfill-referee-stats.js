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
 * Conexion:
 *   Lee DATABASE_URL (Postgres del VPS) igual que lib/db.js. NO usa
 *   Supabase — referee_stats y match_results viven en el VPS.
 *
 * Pre-requisito: haber corrido scripts/migrate-referee-stats.sql en el VPS.
 */

require('dotenv').config({ path: '.env.local' });
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[backfill-referee-stats] falta DATABASE_URL en .env.local');
  process.exit(1);
}

// Misma configuracion SSL que lib/db.js: SSL on por defecto con
// rejectUnauthorized=false (cert auto-firmado del VPS). DATABASE_SSL=false lo desactiva.
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 10_000,
});

const FORCE   = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');
const PAGE_SIZE = 1000;

function normalizeRefereeName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.split(',')[0]?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

async function checkPreconditions() {
  try {
    const { rows } = await pool.query('SELECT count(*)::int AS c FROM referee_stats');
    const count = rows[0]?.c ?? 0;
    if (count > 0 && !FORCE && !DRY_RUN) {
      console.error(`[backfill-referee-stats] referee_stats ya tiene ${count} filas.`);
      console.error('  Re-corre con --force para borrarlas y recalcular desde cero,');
      console.error('  o con --dry-run para ver que escribiria sin tocar nada.');
      process.exit(1);
    }
  } catch (e) {
    console.error('[backfill-referee-stats] no se pudo leer referee_stats (corrio la migracion?):', e.message);
    process.exit(1);
  }
}

async function aggregateFromMatchResults() {
  const aggregator = new Map(); // name -> { matches, yellows, reds, lastDate }
  let offset = 0;
  let scanned = 0;
  let skippedNoReferee = 0;
  let skippedNoCards = 0;

  while (true) {
    const { rows } = await pool.query(
      `SELECT date, yellow_cards, red_cards, full_data
       FROM match_results
       ORDER BY date ASC
       LIMIT $1 OFFSET $2`,
      [PAGE_SIZE, offset]
    );
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
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

    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    process.stdout.write(`\r[backfill] escaneados ${scanned}…`);
  }
  process.stdout.write('\n');

  return { aggregator, scanned, skippedNoReferee, skippedNoCards };
}

async function writeAggregates(aggregator) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (FORCE) {
      console.log('[backfill] --force: borrando referee_stats…');
      await client.query('DELETE FROM referee_stats');
    }

    const rows = Array.from(aggregator.entries());
    const CHUNK = 500;
    let written = 0;

    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      let p = 1;
      for (const [name, acc] of chunk) {
        values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(
          name,
          acc.matches,
          acc.yellows,
          acc.reds,
          acc.yellows + acc.reds,
          acc.lastDate
        );
      }
      // INSERT puro: --force ya borro, sin --force la tabla estaba vacia.
      const sql = `INSERT INTO referee_stats
        (name, matches, total_yellows, total_reds, total_cards, last_match_date)
        VALUES ${values.join(', ')}`;
      await client.query(sql, params);
      written += chunk.length;
      process.stdout.write(`\r[backfill] insertados ${written}/${rows.length}…`);
    }
    process.stdout.write('\n');

    await client.query('COMMIT');
    return written;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
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
    await pool.end();
    return;
  }

  const written = await writeAggregates(aggregator);
  const t2 = Date.now();
  console.log(`[backfill] OK — ${written} arbitros escritos en ${((t2 - t1) / 1000).toFixed(1)}s (scan ${((t1 - t0) / 1000).toFixed(1)}s)`);
  await pool.end();
})().catch(async (e) => {
  console.error('[backfill-referee-stats] FATAL:', e.message);
  try { await pool.end(); } catch {}
  process.exit(1);
});
