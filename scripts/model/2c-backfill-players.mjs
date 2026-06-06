// scripts/model/2c-backfill-players.mjs
// FASE 2C — backfill de fixtures/players faltantes → raw_api_payloads.
//   node --env-file=.env.local scripts/model/2c-backfill-players.mjs --estimate          (NO gasta API)
//   node --env-file=.env.local scripts/model/2c-backfill-players.mjs --run [--rps=3 --daily-cap=80000]
// Tras completar: re-correr 2B para ingerir → node scripts/model/2b-ingest-facts.mjs --reset
//
// Reanudable: la query "fixtures sin players" excluye sola lo ya guardado, así que
// re-correr --run continúa con lo que falte. Vacío de la API (response:[]) se guarda
// (no se re-pide) y se reporta por liga; null/429/red NO se guarda → se reintenta.
import pg from 'pg';

const args = Object.fromEntries(process.argv.slice(2).map(s => { const m = s.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] === '' ? true : m[2]] : [s, true]; }));
const RUN = !!args.run;
const RPS = Number(args.rps) || 3;
const DAILY_CAP = Number(args['daily-cap']) || 80000;
const MIN_INTERVAL = Math.ceil(1000 / RPS);
const API = 'v3.football.api-sports.io';
const KEY = process.env.FOOTBALL_API_KEY;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 3 });

const MISSING_SQL = `
  SELECT f.ref_id AS fixture_id, f.payload->'league'->>'name' AS league
  FROM raw_api_payloads f
  WHERE f.endpoint='fixtures' AND f.sub_key=''
    AND f.payload->'fixture'->'status'->>'short' IN ('FT','AET','PEN')
    AND NOT EXISTS (SELECT 1 FROM raw_api_payloads p WHERE p.endpoint='fixtures/players' AND p.ref_id=f.ref_id AND p.sub_key='')
  ORDER BY f.ref_id`;

let lastReq = 0;
async function gate() { const w = MIN_INTERVAL - (Date.now() - lastReq); if (w > 0) await new Promise(r => setTimeout(r, w)); lastReq = Date.now(); }
async function apiGet(path) {
  await gate();
  try {
    const res = await fetch(`https://${API}${path}`, { headers: { 'x-apisports-key': KEY }, cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (res.status === 429) return { rateLimited: true };
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
async function setCk(last, done, total, status) {
  await pool.query(`INSERT INTO model.ingest_checkpoint (job,last_ref,processed,total,status,updated_at) VALUES ('backfill_players',$1,$2,$3,$4,now()) ON CONFLICT (job) DO UPDATE SET last_ref=EXCLUDED.last_ref, processed=EXCLUDED.processed, total=EXCLUDED.total, status=EXCLUDED.status, updated_at=now()`, [last, done, total, status]);
}

(async () => {
  if (args.estimate) {
    const { rows } = await pool.query(`SELECT count(*)::int n, count(DISTINCT f.payload->'league'->>'id') ligas FROM raw_api_payloads f WHERE f.endpoint='fixtures' AND f.sub_key='' AND f.payload->'fixture'->'status'->>'short' IN ('FT','AET','PEN') AND NOT EXISTS (SELECT 1 FROM raw_api_payloads p WHERE p.endpoint='fixtures/players' AND p.ref_id=f.ref_id AND p.sub_key='')`);
    const n = rows[0].n, h = (n / RPS / 3600).toFixed(1);
    console.log(`[2C estimate] fixtures sin players: ${n} (de ${rows[0].ligas} ligas)`);
    console.log(`  requests API : ${n} (1/fixture)`);
    console.log(`  a ${RPS} req/s → ~${h} h continuas · días con cap ${DAILY_CAP}: ${Math.ceil(n / DAILY_CAP)}`);
    console.log(`  cuota Mega   : ${n} de ~140k libres/día = ${(100 * n / 140000).toFixed(1)}% de un día`);
    await pool.end(); return;
  }
  if (!RUN) { console.log('Usa --estimate (no gasta API) o --run'); await pool.end(); return; }
  if (!KEY) throw new Error('FOOTBALL_API_KEY no está en el env');

  const { rows } = await pool.query(MISSING_SQL);
  console.log(`[2C] ${rows.length} fixtures sin players · rps=${RPS} · daily-cap=${DAILY_CAP}`);
  let done = 0, withPlayers = 0, empty = 0, errors = 0, today = 0; const emptyByLeague = {};
  await setCk(0, 0, rows.length, 'running');
  for (const r of rows) {
    if (today >= DAILY_CAP) { console.log(`[2C] daily-cap ${DAILY_CAP} alcanzado → paro. Re-corre --run mañana (reanuda solo lo que falte).`); break; }
    const fid = Number(r.fixture_id);
    let json = await apiGet(`/fixtures/players?fixture=${fid}`); today++;
    let t = 0;
    while (json?.rateLimited && t < 5) { const b = 2000 * (t + 1); console.log(`  429 fid=${fid} → backoff ${b}ms`); await new Promise(x => setTimeout(x, b)); json = await apiGet(`/fixtures/players?fixture=${fid}`); today++; t++; }
    if (!json || json.rateLimited) { errors++; done++; continue; }   // transitorio → no guardar → se reintenta luego
    const arr = json.response || [];
    await pool.query(`INSERT INTO raw_api_payloads (endpoint, ref_type, ref_id, season, sub_key, payload, fetched_at) VALUES ('fixtures/players','fixture',$1,NULL,'',$2::jsonb,NOW()) ON CONFLICT (endpoint, ref_id, sub_key) DO UPDATE SET payload=EXCLUDED.payload, fetched_at=NOW()`, [fid, JSON.stringify(json)]);
    if (arr.length > 0) withPlayers++; else { empty++; emptyByLeague[r.league] = (emptyByLeague[r.league] || 0) + 1; }
    done++;
    if (done % 200 === 0) { await setCk(fid, done, rows.length, 'running'); console.log(`  ${done}/${rows.length} · conPlayers=${withPlayers} vacíos=${empty} err=${errors} · hoy=${today}`); }
  }
  await setCk(0, done, rows.length, 'done');
  console.log(`\n[2C] FIN · procesados=${done} · conPlayers=${withPlayers} · vacíos=${empty} · errores(transitorios)=${errors}`);
  const top = Object.entries(emptyByLeague).sort((a, b) => b[1] - a[1]).slice(0, 25);
  if (top.length) { console.log(`[2C] ligas SIN players devueltos por la API (quedan sin perfil de jugador, es correcto):`); for (const [lg, n] of top) console.log(`   ${String(n).padStart(5)}  ${lg}`); }
  console.log(`\n→ Ahora ingiere: node --env-file=.env.local scripts/model/2b-ingest-facts.mjs --reset`);
  await pool.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
