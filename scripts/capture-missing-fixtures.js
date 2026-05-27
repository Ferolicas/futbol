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
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true]; }));
const RUN = !!args.run;
const CONCURRENCY = Number(args.concurrency) || 4;

const API_HOST = 'v3.football.api-sports.io';
const API_KEY = process.env.FOOTBALL_API_KEY;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});

let calls = 0;
// Devuelve { ok, json }. ok=false si error/rate-limit persistente → el caller NO
// guarda (deja la fila para el próximo run). Reintenta el rate-limit BLANDO de
// API-Football (HTTP 200 con errors:{rateLimit|requests}), no solo el 429.
async function apiGet(path, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      calls++;
      const res = await fetch(`https://${API_HOST}${path}`, { headers: { 'x-apisports-key': API_KEY }, signal: AbortSignal.timeout(20000) });
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue; }
      if (!res.ok) { if (i === tries - 1) return { ok: false, json: { response: [] } }; await sleep(1500 * (i + 1)); continue; }
      const json = await res.json();
      const errs = json.errors && (Array.isArray(json.errors) ? json.errors.length : Object.keys(json.errors).length);
      if (errs) {
        const s = JSON.stringify(json.errors).toLowerCase();
        if (/rate|requests|limit/.test(s)) { await sleep(4000 * (i + 1)); continue; } // límite blando → reintentar
        return { ok: false, json }; // otro error (token, etc.) → no guardar
      }
      return { ok: true, json };
    } catch (e) { if (i === tries - 1) return { ok: false, json: { response: [] } }; await sleep(1500 * (i + 1)); }
  }
  return { ok: false, json: { response: [] } };
}
// Sobrescribe (DO UPDATE) para reemplazar payloads vacios/basura guardados por
// runs previos rate-limiteados.
async function save(endpoint, refType, refId, subKey, payload) {
  await pool.query(
    `INSERT INTO raw_api_payloads (endpoint, ref_type, ref_id, season, sub_key, payload, fetched_at)
     VALUES ($1,$2,$3,NULL,$4,$5::jsonb,NOW())
     ON CONFLICT (endpoint, ref_id, sub_key) DO UPDATE SET payload=EXCLUDED.payload, fetched_at=NOW()`,
    [endpoint, refType, refId, subKey, JSON.stringify(payload)]
  );
}

async function processFixture(fid) {
  // 'fixtures' → el OBJETO fixture (response[0]). Solo si la llamada tuvo éxito.
  const r = await apiGet(`/fixtures?id=${fid}`);
  const obj = r.ok ? r.json?.response?.[0] : null;
  if (obj) await save('fixtures', 'fixture', fid, '', obj);
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
}

async function mapPool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { await fn(items[idx]); } catch (e) { console.warn('  fail:', e.message); } }
  }));
}

(async () => {
  const { rows } = await pool.query(
    `SELECT mp.fixture_id FROM match_predictions mp
     WHERE mp.finalized_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM raw_api_payloads r WHERE r.endpoint='fixtures' AND r.ref_id = mp.fixture_id)
     ORDER BY mp.fixture_id`
  );
  const fids = rows.map(r => Number(r.fixture_id));
  console.log(`\nFixtures finalizados SIN crudo: ${fids.length}`);

  if (!RUN) {
    console.log(`── ESTIMACIÓN ── ${fids.length} fixtures × 5 endpoints ≈ ${fids.length * 5} llamadas · ~${Math.round(fids.length * 5 / 400)}-${Math.round(fids.length * 5 / 180)} min`);
    console.log(`  Para ejecutar: node --env-file=.env scripts/capture-missing-fixtures.js --run\n`);
    await pool.end();
    return;
  }
  if (!API_KEY) { console.error('FATAL: FOOTBALL_API_KEY no está'); process.exit(1); }

  let done = 0;
  const t0 = Date.now();
  await mapPool(fids, CONCURRENCY, async (fid) => {
    await processFixture(fid);
    if (++done % 50 === 0) console.log(`  ${done}/${fids.length} · calls=${calls} · ${Math.round((Date.now() - t0) / 60000)}min`);
  });
  console.log(`\n✓ Capturados ${fids.length} fixtures faltantes · ${calls} llamadas. Ahora re-corre backfill-actuals.js.`);
  await pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
