/* eslint-disable no-console */
// Repara exclusivamente la semántica de cobertura de match_results:
// null = el proveedor no entregó el mercado; 0 = cero observado de verdad.
// Dry-run por defecto. Usar --run para aplicar dentro de una transacción.

try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');
const { isDeepStrictEqual } = require('node:util');
const { extractResultCoverage } = require('../lib/football-result-snapshot.cjs');

const RUN = process.argv.includes('--run');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 2,
});

function same(a, b) {
  // JSONB no conserva el orden de las claves; comparar JSON.stringify daría
  // falsos positivos aunque el contenido fuera idéntico.
  return isDeepStrictEqual(a ?? null, b ?? null);
}

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL no configurado');
  const { rows } = await pool.query(`
    SELECT fixture_id, full_data, corners, yellow_cards, red_cards
    FROM match_results
    ORDER BY fixture_id
  `);

  const changes = [];
  let missingFullData = 0;
  const categories = { corners: 0, yellowCards: 0, redCards: 0 };

  for (const row of rows) {
    if (!row.full_data || typeof row.full_data !== 'object') {
      missingFullData++;
      continue;
    }
    const coverage = extractResultCoverage(row.full_data);
    const changed = {
      corners: !same(row.corners, coverage.corners),
      yellowCards: !same(row.yellow_cards, coverage.yellowCards),
      redCards: !same(row.red_cards, coverage.redCards),
    };
    if (!Object.values(changed).some(Boolean)) continue;
    for (const key of Object.keys(categories)) if (changed[key]) categories[key]++;
    changes.push({ fixtureId: row.fixture_id, coverage });
  }

  console.log(JSON.stringify({
    mode: RUN ? 'apply' : 'dry-run',
    scanned: rows.length,
    changedRows: changes.length,
    missingFullData,
    changedFields: categories,
  }, null, 2));

  if (!RUN || changes.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of changes) {
      await client.query(
        `UPDATE match_results
         SET corners=$2::jsonb, yellow_cards=$3::jsonb, red_cards=$4::jsonb
         WHERE fixture_id=$1`,
        [
          item.fixtureId,
          JSON.stringify(item.coverage.corners),
          JSON.stringify(item.coverage.yellowCards),
          JSON.stringify(item.coverage.redCards),
        ],
      );
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ applied: changes.length }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
