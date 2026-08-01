/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Re-captura TODOS los crudos envenenados (429 blando, cuota diaria, HTTP,
// token o error de red) sin importar endpoint. Los vacíos válidos no se
// consideran veneno y se gestionan en api_capture_failures.
//
// Diferencia clave vs capture-missing-fixtures.js: PACER GLOBAL que respeta el
// límite del plan (≈150/min). Concurrencia baja + intervalo mínimo entre el
// INICIO de cada llamada → nunca ráfaga. Reintenta el rate-limit blando con
// backoff. ON CONFLICT DO UPDATE sobrescribe SOLO si la respuesta fue OK
// (éxito o vacío legítimo) → así un vacío real reemplaza al error y deja de
// contar como envenenado; un error persistente se deja para el próximo run.
//
//   node --env-file=.env scripts/recapture-ratelimited.js              # ESTIMAR (no gasta API)
//   node --env-file=.env scripts/recapture-ratelimited.js --run        # EJECUTAR
//   flags: --rate=140  --concurrency=3  --limit=N  --endpoint=events|statistics
//          --also-requests  (incluye también los envenenados por límite DIARIO 'requests')
// ────────────────────────────────────────────────────────────────────────
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true]; }));
const RUN = !!args.run;
const RATE = Number(args.rate) || 420;          // margen bajo el plan de 450/min
process.env.FOOTBALL_API_RATE_PER_MIN = String(Math.min(420, RATE));
const { footballApiRequest, footballApiPath, payloadQuality, closeFootballApiClient } = require('../lib/football-api-client.cjs');
const CONCURRENCY = Number(args.concurrency) || 3;
const LIMIT = args.limit ? Number(args.limit) : null;
// --endpoint acepta CUALQUIER endpoint: nombre completo ('fixtures/players',
// 'fixtures/headtohead', 'injuries') o corto ('players','events','statistics' →
// se les antepone 'fixtures/'). Sin flag → events + statistics (default).
function normEndpoint(s) {
  if (!s || s === true) return null;
  s = String(s).trim();
  if (['injuries','players','predictions','teams','coachs','transfers','venues'].includes(s)) return s;
  return s.includes('/') ? s : `fixtures/${s}`;
}
const ENDPOINTS = args.endpoint
  ? [normEndpoint(args.endpoint)].filter(Boolean)
  : ['injuries', 'fixtures/players', 'fixtures/lineups', 'predictions', 'players',
     'fixtures/events', 'fixtures/statistics', 'teams/statistics', 'players/squads',
     'transfers', 'coachs', 'teams', 'venues', 'fixtures/headtohead'];

const API_KEY = process.env.FOOTBALL_API_KEY;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});

// Cualquier body con error es veneno. Un response vacío con errors={} es una
// respuesta válida y no entra aquí.
const POISON = `(
  payload ? '__error' OR payload ? '__http' OR
  (jsonb_typeof(payload->'errors')='object' AND payload->'errors'<>'{}'::jsonb) OR
  (jsonb_typeof(payload->'errors')='array' AND jsonb_array_length(payload->'errors')>0)
)`;
// Path de API por endpoint (genérico). headtohead va por par (ref_id-sub_key);
// injuries y el resto van por fixture (?fixture=ref_id).

let calls = 0, softRetries = 0;
// Devuelve { ok, json }. ok=false → el caller NO guarda (deja la fila). Cada
// intento pasa por el pacer (incluidos los reintentos) → respeta el límite.
async function apiGet(path) {
  calls++;
  try {
    const result = await footballApiRequest(path, { apiKey: API_KEY, timeoutMs: 20_000, retries: 5 });
    return { ok: payloadQuality(result.payload) > 0, json: result.payload };
  } catch (error) {
    if (error?.code === 'RATE_LIMIT') softRetries++;
    return { ok: false, json: null, error: error?.message || String(error) };
  }
}

async function save(endpoint, refType, refId, season, subKey, payload) {
  if (payloadQuality(payload) === 0) return false;
  await pool.query(
    `INSERT INTO raw_api_payloads (endpoint, ref_type, ref_id, season, sub_key, payload, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,NOW())
     ON CONFLICT (endpoint, ref_id, sub_key) DO UPDATE SET payload=EXCLUDED.payload,ref_type=EXCLUDED.ref_type,season=EXCLUDED.season,fetched_at=NOW()`,
    [endpoint, refType || 'fixture', refId, season ?? null, subKey, JSON.stringify(payload)]
  );
  try {
    await pool.query(
      `UPDATE api_capture_failures
       SET resolved_at=NOW(),next_retry_at=NULL,last_error=NULL
       WHERE endpoint=$1 AND ref_id=$2 AND sub_key=$3`,
      [endpoint, refId, subKey],
    );
  } catch {}
  return true;
}

async function mapPool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { await fn(items[idx]); } catch (e) { console.warn('  fail:', e.message); } }
  }));
}

async function coverage() {
  const { rows } = await pool.query(
    `SELECT endpoint,
       COUNT(*)::int total,
       COUNT(*) FILTER (WHERE CASE
         WHEN jsonb_typeof(payload->'response')='array' THEN jsonb_array_length(payload->'response')>0
         WHEN jsonb_typeof(payload->'response')='object' THEN payload->'response'<>'{}'::jsonb
         ELSE false END)::int with_data,
       COUNT(*) FILTER (WHERE ${POISON})::int poison
     FROM raw_api_payloads WHERE endpoint = ANY($1) GROUP BY endpoint ORDER BY endpoint`,
    [ENDPOINTS]
  );
  for (const r of rows) {
    const pct = r.total ? Math.round(100 * r.with_data / r.total) : 0;
    console.log(`  ${r.endpoint.padEnd(20)} total=${r.total}  con_datos=${r.with_data} (${pct}%)  envenenado=${r.poison}`);
  }
  return rows;
}

(async () => {
  console.log(`\n=== Cobertura ACTUAL ===`);
  await coverage();

  // Conteo de envenenados a re-capturar (por endpoint).
  const { rows: cnt } = await pool.query(
    `SELECT endpoint, COUNT(*)::int n FROM raw_api_payloads WHERE endpoint = ANY($1) AND ${POISON} GROUP BY endpoint ORDER BY endpoint`,
    [ENDPOINTS]
  );
  const totalPoison = cnt.reduce((s, r) => s + r.n, 0);
  console.log(`\n=== Envenenados a re-capturar (cualquier error) ===`);
  for (const r of cnt) console.log(`  ${r.endpoint.padEnd(20)} ${r.n}`);
  console.log(`  TOTAL: ${totalPoison} llamadas`);

  if (!RUN) {
    const minFloor = totalPoison / RATE;                 // sin reintentos
    const minReal = totalPoison / (RATE * 0.85);          // margen por reintentos/latencia
    console.log(`\n── ESTIMACIÓN (ritmo ${RATE}/min, concurrencia ${CONCURRENCY}) ──`);
    console.log(`  ~${totalPoison} llamadas · ~${Math.round(minFloor)}–${Math.round(minReal)} min (${(minFloor / 60).toFixed(1)}–${(minReal / 60).toFixed(1)} h)`);
    console.log(`  Para ejecutar: node --env-file=.env scripts/recapture-ratelimited.js --run\n`);
    await pool.end();
    await closeFootballApiClient();
    return;
  }

  if (!API_KEY) { console.error('FATAL: FOOTBALL_API_KEY no está'); process.exit(1); }

  let q = `SELECT endpoint,ref_type,ref_id,season,sub_key FROM raw_api_payloads WHERE endpoint = ANY($1) AND ${POISON} ORDER BY endpoint,ref_id`;
  if (LIMIT) q += ` LIMIT ${LIMIT}`;
  const { rows } = await pool.query(q, [ENDPOINTS]);
  console.log(`\nRe-capturando ${rows.length} payloads envenenados…`);

  let done = 0, saved = 0, stillBad = 0;
  const t0 = Date.now();
  await mapPool(rows, CONCURRENCY, async (row) => {
    const fid = Number(row.ref_id);
    const path = footballApiPath(row.endpoint, fid, row.sub_key || '', row.season);
    const resp = path ? await apiGet(path) : { ok: false, error: 'ruta no resoluble' };
    if (resp.ok && resp.json && await save(row.endpoint, row.ref_type, fid, row.season, row.sub_key || '', resp.json)) { saved++; }
    else {
      stillBad++;
      try {
        await pool.query(
          `INSERT INTO api_capture_failures(endpoint,ref_id,sub_key,attempts,status,last_error,last_attempt_at,next_retry_at)
           VALUES ($1,$2,$3,1,'retry',$4,NOW(),NOW()+INTERVAL '24 hours')
           ON CONFLICT(endpoint,ref_id,sub_key) DO UPDATE SET attempts=api_capture_failures.attempts+1,status='retry',last_error=EXCLUDED.last_error,last_attempt_at=NOW(),next_retry_at=EXCLUDED.next_retry_at,resolved_at=NULL`,
          [row.endpoint, fid, row.sub_key || '', resp.error || 're-captura fallida'],
        );
      } catch {}
    }
    if (++done % 100 === 0) {
      const minEl = (Date.now() - t0) / 60000;
      console.log(`  ${done}/${rows.length} · ok=${saved} fallo=${stillBad} · calls=${calls} · reintentos=${softRetries} · ${minEl.toFixed(1)}min · ritmo=${(calls / Math.max(minEl, 0.01)).toFixed(0)}/min`);
    }
  });

  const minEl = (Date.now() - t0) / 60000;
  console.log(`\n✓ Re-captura completa: ${rows.length} procesados · ${saved} sobrescritos OK · ${stillBad} siguen mal · ${calls} llamadas · ${softRetries} reintentos blandos · ${minEl.toFixed(1)}min (ritmo ${(calls / Math.max(minEl, 0.01)).toFixed(0)}/min)`);
  console.log(`\n=== Cobertura FINAL ===`);
  await coverage();
  if (stillBad > 0) console.log(`\n  ${stillBad} siguen envenenados — re-corre el script para reintentarlos (idempotente).`);
  await pool.end();
  await closeFootballApiClient();
})().catch(async e => { console.error('FATAL:', e.message); await closeFootballApiClient(); process.exit(1); });
