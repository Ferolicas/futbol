/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Re-captura los crudos de fixtures/events y fixtures/statistics que quedaron
// ENVENENADOS por el rate-limit BLANDO (HTTP 200 + errors:{rateLimit}) y se
// guardaron igual vía ON CONFLICT. NO toca los vacíos legítimos (errors {}).
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
const RATE = Number(args.rate) || 140;          // llamadas/min objetivo (margen bajo 150 del plan)
const CONCURRENCY = Number(args.concurrency) || 3;
const LIMIT = args.limit ? Number(args.limit) : null;
const ALSO_REQUESTS = !!args['also-requests'];
const ENDPOINTS = args.endpoint
  ? [`fixtures/${args.endpoint === 'events' ? 'events' : 'statistics'}`]
  : ['fixtures/events', 'fixtures/statistics'];

const API_HOST = 'v3.football.api-sports.io';
const API_KEY = process.env.FOOTBALL_API_KEY;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});

// Predicado de "envenenado" (rate-limit blando), NO vacío legítimo.
const POISON = `((payload->'errors'->>'rateLimit') IS NOT NULL${ALSO_REQUESTS ? ` OR (payload->'errors'->>'requests') IS NOT NULL` : ''})`;
const pathFor = (endpoint, fid) => endpoint === 'fixtures/events'
  ? `/fixtures/events?fixture=${fid}`
  : `/fixtures/statistics?fixture=${fid}`;

// ── Pacer global: separa el INICIO de cada llamada ≥ INTERVAL ms, sin importar
//    la concurrencia → tasa global ≤ RATE/min. La reserva de slot es síncrona
//    (antes de cualquier await) → segura entre workers concurrentes.
const INTERVAL = Math.ceil(60000 / RATE);
let nextSlot = 0;
async function pace() {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + INTERVAL;
  const wait = start - now;
  if (wait > 0) await sleep(wait);
}

let calls = 0, softRetries = 0;
// Devuelve { ok, json }. ok=false → el caller NO guarda (deja la fila). Cada
// intento pasa por el pacer (incluidos los reintentos) → respeta el límite.
async function apiGet(path, tries = 6) {
  for (let i = 0; i < tries; i++) {
    await pace();
    try {
      calls++;
      const res = await fetch(`https://${API_HOST}${path}`, { headers: { 'x-apisports-key': API_KEY }, signal: AbortSignal.timeout(20000) });
      if (res.status === 429) { softRetries++; await sleep(4000 * (i + 1)); continue; }
      if (!res.ok) { if (i === tries - 1) return { ok: false, json: null }; await sleep(1500 * (i + 1)); continue; }
      const json = await res.json();
      const errs = json.errors && (Array.isArray(json.errors) ? json.errors.length : Object.keys(json.errors).length);
      if (errs) {
        const s = JSON.stringify(json.errors).toLowerCase();
        if (/rate|requests|limit/.test(s)) { softRetries++; await sleep(5000 * (i + 1)); continue; } // límite blando → reintentar
        return { ok: false, json }; // otro error (token, etc.) → no guardar
      }
      return { ok: true, json };
    } catch (e) { if (i === tries - 1) return { ok: false, json: null }; await sleep(1500 * (i + 1)); }
  }
  return { ok: false, json: null };
}

async function save(endpoint, refId, subKey, payload) {
  await pool.query(
    `INSERT INTO raw_api_payloads (endpoint, ref_type, ref_id, season, sub_key, payload, fetched_at)
     VALUES ($1,'fixture',$2,NULL,$3,$4::jsonb,NOW())
     ON CONFLICT (endpoint, ref_id, sub_key) DO UPDATE SET payload=EXCLUDED.payload, fetched_at=NOW()`,
    [endpoint, refId, subKey, JSON.stringify(payload)]
  );
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
       COUNT(*) FILTER (WHERE (CASE WHEN jsonb_typeof(payload->'response')='array' THEN jsonb_array_length(payload->'response') ELSE 0 END) > 0)::int with_data,
       COUNT(*) FILTER (WHERE (payload->'errors'->>'rateLimit') IS NOT NULL)::int poison_rate,
       COUNT(*) FILTER (WHERE (payload->'errors'->>'requests') IS NOT NULL)::int poison_req
     FROM raw_api_payloads WHERE endpoint = ANY($1) GROUP BY endpoint ORDER BY endpoint`,
    [ENDPOINTS]
  );
  for (const r of rows) {
    const pct = r.total ? Math.round(100 * r.with_data / r.total) : 0;
    console.log(`  ${r.endpoint.padEnd(20)} total=${r.total}  con_datos=${r.with_data} (${pct}%)  envenenado[rateLimit]=${r.poison_rate}  [requests]=${r.poison_req}`);
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
  console.log(`\n=== Envenenados a re-capturar (${ALSO_REQUESTS ? 'rateLimit + requests' : 'rateLimit'}) ===`);
  for (const r of cnt) console.log(`  ${r.endpoint.padEnd(20)} ${r.n}`);
  console.log(`  TOTAL: ${totalPoison} llamadas`);

  if (!RUN) {
    const minFloor = totalPoison / RATE;                 // sin reintentos
    const minReal = totalPoison / (RATE * 0.85);          // margen por reintentos/latencia
    console.log(`\n── ESTIMACIÓN (ritmo ${RATE}/min, concurrencia ${CONCURRENCY}) ──`);
    console.log(`  ~${totalPoison} llamadas · ~${Math.round(minFloor)}–${Math.round(minReal)} min (${(minFloor / 60).toFixed(1)}–${(minReal / 60).toFixed(1)} h)`);
    console.log(`  Para ejecutar: node --env-file=.env scripts/recapture-ratelimited.js --run\n`);
    await pool.end();
    return;
  }

  if (!API_KEY) { console.error('FATAL: FOOTBALL_API_KEY no está'); process.exit(1); }

  let q = `SELECT endpoint, ref_id, sub_key FROM raw_api_payloads WHERE endpoint = ANY($1) AND ${POISON} ORDER BY endpoint, ref_id`;
  if (LIMIT) q += ` LIMIT ${LIMIT}`;
  const { rows } = await pool.query(q, [ENDPOINTS]);
  console.log(`\nRe-capturando ${rows.length} payloads envenenados…`);

  let done = 0, saved = 0, stillBad = 0;
  const t0 = Date.now();
  await mapPool(rows, CONCURRENCY, async (row) => {
    const fid = Number(row.ref_id);
    const resp = await apiGet(pathFor(row.endpoint, fid));
    if (resp.ok && resp.json) { await save(row.endpoint, fid, row.sub_key || '', resp.json); saved++; }
    else stillBad++;
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
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
