/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Captura los crudos FALTANTES de los fixtures que están en match_predictions
// (finalized_at NOT NULL) pero NO tienen entrada en raw_api_payloads. Son los
// finalizados viejos (abr-may) que las tandas por equipo-temporada 25/26 no
// cubrieron. Necesarios para reconstruir actuals_full → entrenar.
//
// Por fixture: /fixtures?id, /fixtures/statistics, /fixtures/events,
//              /fixtures/lineups, /injuries.  Idempotente.
//
//   node --env-file=.env scripts/capture-missing-fixtures.js            # estimar
//   node --env-file=.env scripts/capture-missing-fixtures.js --run      # ejecutar
// ────────────────────────────────────────────────────────────────────────
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');
const { footballApiRequest, payloadQuality, closeFootballApiClient } = require('../lib/football-api-client.cjs');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true]; }));
const RUN = !!args.run;
const CONCURRENCY = Number(args.concurrency) || 4;
const RELATED_SINCE = args['related-since'] ? new Date(String(args['related-since'])) : null;
const ALL_RELATED = !!args['all-related'];
const FIXTURE_ONLY = !!args['fixture-only'];
if (RELATED_SINCE && !Number.isFinite(RELATED_SINCE.getTime())) throw new Error('--related-since debe ser una fecha ISO válida');

const API_KEY = process.env.FOOTBALL_API_KEY;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});

let calls = 0;
// Devuelve { ok, json }. ok=false si error/rate-limit persistente → el caller NO
// guarda (deja la fila para el próximo run). Reintenta el rate-limit BLANDO de
// API-Football (HTTP 200 con errors:{rateLimit|requests}), no solo el 429.
async function apiGet(path) {
  calls++;
  try {
    const result = await footballApiRequest(path, { apiKey: API_KEY, timeoutMs: 20_000, retries: 4 });
    return { ok: true, json: result.payload };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
// Sobrescribe (DO UPDATE) para reemplazar payloads vacios/basura guardados por
// runs previos rate-limiteados.
async function save(endpoint, refType, refId, subKey, payload) {
  const nextQuality = payloadQuality(payload);
  if (nextQuality === 0) return false;
  const { rows } = await pool.query(
    `SELECT payload FROM raw_api_payloads WHERE endpoint=$1 AND ref_id=$2 AND sub_key=$3`,
    [endpoint, refId, subKey],
  );
  if (rows.length && payloadQuality(rows[0].payload) === 2 && nextQuality < 2) return false;
  await pool.query(
    `INSERT INTO raw_api_payloads (endpoint, ref_type, ref_id, season, sub_key, payload, fetched_at)
     VALUES ($1,$2,$3,NULL,$4,$5::jsonb,NOW())
     ON CONFLICT (endpoint, ref_id, sub_key) DO UPDATE SET payload=EXCLUDED.payload, fetched_at=NOW()`,
    [endpoint, refType, refId, subKey, JSON.stringify(payload)]
  );
  return true;
}

async function processFixture(fid) {
  // 'fixtures' → el OBJETO fixture (response[0]). Solo si la llamada tuvo éxito.
  const r = await apiGet(`/fixtures?id=${fid}`);
  const obj = r.ok ? r.json?.response?.[0] : null;
  if (!obj) return { ok: false, error: r.error || 'fixture vacío' };
  await save('fixtures', 'fixture', fid, '', obj);
  if (FIXTURE_ONLY) return { ok: true };
  // El resto: JSON completo, solo si ok (no clavar vacíos por rate-limit).
  for (const [endpoint, path, subKey] of [
    ['fixtures/statistics', `/fixtures/statistics?fixture=${fid}`, ''],
    ['fixtures/events', `/fixtures/events?fixture=${fid}`, ''],
    ['fixtures/lineups', `/fixtures/lineups?fixture=${fid}`, ''],
    ['injuries', `/injuries?fixture=${fid}`, `fx:${fid}`],
  ]) {
    const resp = await apiGet(path);
    if (resp.ok) await save(endpoint, 'fixture', fid, subKey, resp.json);
  }
  return { ok: true };
}

async function mapPool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}

(async () => {
  const relatedQuery = `SELECT DISTINCT rel.ref_id AS fixture_id
       FROM raw_api_payloads rel
       WHERE %TIME_PREDICATE%
         AND (
           rel.endpoint IN ('fixtures/statistics','fixtures/events','fixtures/players','fixtures/lineups','fixtures/halfstats')
           OR (rel.endpoint='injuries' AND rel.sub_key LIKE 'fx:%')
         )
         AND NOT EXISTS (
           SELECT 1 FROM raw_api_payloads f
           WHERE f.endpoint='fixtures' AND f.ref_id=rel.ref_id AND f.sub_key=''
         )
       ORDER BY fixture_id`;
  const { rows } = (RELATED_SINCE || ALL_RELATED)
    ? await pool.query(
      relatedQuery.replace('%TIME_PREDICATE%', RELATED_SINCE ? `rel.fetched_at >= $1::timestamptz` : 'TRUE'),
      RELATED_SINCE ? [RELATED_SINCE.toISOString()] : [])
    : await pool.query(
      `SELECT mp.fixture_id FROM match_predictions mp
       WHERE mp.finalized_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM raw_api_payloads r WHERE r.endpoint='fixtures' AND r.ref_id = mp.fixture_id)
       ORDER BY mp.fixture_id`
    );
  const fids = rows.map(r => Number(r.fixture_id));
  console.log(
    `\nFixtures SIN crudo base: ${fids.length}` +
    (RELATED_SINCE ? ` · relacionados desde ${RELATED_SINCE.toISOString()}` : '') +
    (ALL_RELATED ? ' · todos los relacionados históricos' : '')
  );

  if (!RUN) {
    const callsPerFixture = FIXTURE_ONLY ? 1 : 5;
    console.log(`── ESTIMACIÓN ── ${fids.length} fixtures × ${callsPerFixture} endpoints ≈ ${fids.length * callsPerFixture} llamadas · ~${Math.round(fids.length * callsPerFixture / 400)}-${Math.round(fids.length * callsPerFixture / 180)} min`);
    console.log(`  Para ejecutar: node --env-file=.env scripts/capture-missing-fixtures.js --run\n`);
    await pool.end();
    await closeFootballApiClient();
    return;
  }
  if (!API_KEY) { console.error('FATAL: FOOTBALL_API_KEY no está'); process.exit(1); }

  let done = 0, savedFixtures = 0, failed = 0;
  const t0 = Date.now();
  await mapPool(fids, CONCURRENCY, async (fid) => {
    const result = await processFixture(fid);
    if (result.ok) savedFixtures++;
    else {
      failed++;
      await pool.query(
        `INSERT INTO api_capture_failures(endpoint,ref_id,sub_key,attempts,status,last_error,last_attempt_at,next_retry_at)
         VALUES ('fixtures',$1,'',1,'retry',$2,NOW(),NOW()+INTERVAL '1 hour')
         ON CONFLICT(endpoint,ref_id,sub_key) DO UPDATE SET
           attempts=api_capture_failures.attempts+1,status='retry',last_error=EXCLUDED.last_error,
           last_attempt_at=NOW(),next_retry_at=EXCLUDED.next_retry_at,resolved_at=NULL`,
        [fid, result.error || 'fixture no recuperado'],
      );
    }
    if (++done % 50 === 0) console.log(`  ${done}/${fids.length} · ok=${savedFixtures} fail=${failed} · calls=${calls} · ${Math.round((Date.now() - t0) / 60000)}min`);
  });
  console.log(`\n✓ Recuperación terminada: ${savedFixtures}/${fids.length} fixtures · fallos=${failed} · ${calls} llamadas.`);
  if (failed) process.exitCode = 2;
  await pool.end();
  await closeFootballApiClient();
})().catch(async e => { console.error('FATAL:', e.message); await closeFootballApiClient(); process.exit(1); });
