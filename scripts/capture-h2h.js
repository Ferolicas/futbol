/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Paso 0.5 — Captura H2H multi-temporada para los Niveles 2 y 3 del meta-modelo.
//
// Por cada par único de equipos en match_predictions:
//   /fixtures/headtohead?h2h=A-B&last=8  → guarda en raw_api_payloads.
//   Para cada uno de esos ≤8 cruces, captura su CONTEXTO (statistics, events,
//   lineups, injuries) — necesario para el análisis de EXCEPCIONES (Nivel 3).
//   Dedupe con lo ya capturado en el backfill de 25/26.
//
// Idempotente / resumible. node --env-file=.env scripts/capture-h2h.js [--estimate|--run]
// ────────────────────────────────────────────────────────────────────────
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true]; }));
const RUN = !!args.run;
const LAST = Number(args.last) || 8;
const CONCURRENCY = Number(args.concurrency) || 6;

const API_HOST = 'v3.football.api-sports.io';
const API_KEY = process.env.FOOTBALL_API_KEY;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});

let calls = 0;
async function apiGet(path, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      calls++;
      const res = await fetch(`https://${API_HOST}${path}`, { headers: { 'x-apisports-key': API_KEY }, signal: AbortSignal.timeout(20000) });
      if (res.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (!res.ok) return { response: [] };
      const json = await res.json();
      if (json.errors && Object.keys(json.errors).length) return { response: [] };
      return json;
    } catch (e) { if (i === tries - 1) return { response: [] }; await sleep(1000 * (i + 1)); }
  }
  return { response: [] };
}

async function exists(endpoint, refId, subKey = '') {
  const { rows } = await pool.query(`SELECT 1 FROM raw_api_payloads WHERE endpoint=$1 AND ref_id=$2 AND sub_key=$3`, [endpoint, refId, subKey]);
  return rows.length > 0;
}
async function save(endpoint, refType, refId, season, subKey, payload) {
  await pool.query(
    `INSERT INTO raw_api_payloads (endpoint, ref_type, ref_id, season, sub_key, payload, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,NOW()) ON CONFLICT (endpoint, ref_id, sub_key) DO NOTHING`,
    [endpoint, refType, refId, season ?? null, subKey, JSON.stringify(payload)]
  );
}
async function captureFixtureContext(fid) {
  // Contexto de un cruce H2H para el análisis de excepciones. Idempotente.
  for (const [endpoint, path, subKey] of [
    ['fixtures/statistics', `/fixtures/statistics?fixture=${fid}`, ''],
    ['fixtures/events', `/fixtures/events?fixture=${fid}`, ''],
    ['fixtures/lineups', `/fixtures/lineups?fixture=${fid}`, ''],
    ['injuries', `/injuries?fixture=${fid}`, `fx:${fid}`],
  ]) {
    if (await exists(endpoint, fid, subKey)) continue;
    const payload = await apiGet(path);
    await save(endpoint, 'fixture', fid, null, subKey, payload);
  }
}

async function processPair([a, b]) {
  if (!(await exists('fixtures/headtohead', a, String(b)))) {
    const resp = await apiGet(`/fixtures/headtohead?h2h=${a}-${b}&last=${LAST}`);
    await save('fixtures/headtohead', 'pair', a, null, String(b), resp);
    // Contexto de cada cruce devuelto (también guarda el fixture en bruto).
    for (const f of (resp?.response || [])) {
      const fid = f?.fixture?.id; if (!fid) continue;
      if (!(await exists('fixtures', fid))) await save('fixtures', 'fixture', fid, null, '', f);
      await captureFixtureContext(fid);
    }
  }
}

async function mapPool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { await fn(items[idx]); } catch (e) { console.warn('  pair fail:', e.message); } }
  }));
}

(async () => {
  const { rows } = await pool.query(
    `SELECT DISTINCT LEAST((home_team->>'id')::int,(away_team->>'id')::int) AS a,
                     GREATEST((home_team->>'id')::int,(away_team->>'id')::int) AS b
     FROM match_predictions
     WHERE home_team->>'id' IS NOT NULL AND away_team->>'id' IS NOT NULL`
  );
  const pairs = rows.map(r => [r.a, r.b]).filter(([a, b]) => a && b && a !== b);
  console.log(`\nPares únicos: ${pairs.length} · profundidad H2H: ${LAST}`);

  if (!RUN) {
    // 1 H2H + hasta LAST×4 contexto por par, con mucho dedupe (los cruces de
    // 25/26 ya están en crudo). Estimación conservadora.
    const est = pairs.length * (1 + LAST * 4);
    console.log(`── ESTIMACIÓN (máx, antes de dedupe) ──`);
    console.log(`  ~${est} llamadas en el peor caso; real mucho menor por dedupe con 25/26.`);
    console.log(`  Para ejecutar: node --env-file=.env scripts/capture-h2h.js --run\n`);
    await pool.end();
    return;
  }

  if (!API_KEY) { console.error('FATAL: FOOTBALL_API_KEY no está'); process.exit(1); }
  let done = 0;
  const t0 = Date.now();
  await mapPool(pairs, CONCURRENCY, async (p) => {
    await processPair(p);
    if (++done % 50 === 0) console.log(`  ${done}/${pairs.length} pares · calls=${calls} · ${Math.round((Date.now() - t0) / 60000)}min`);
  });
  console.log(`\n✓ H2H capturado: ${pairs.length} pares · ${calls} llamadas.`);
  await pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
