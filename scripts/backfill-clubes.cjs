/* eslint-disable */
// Backfill TOTAL de clubes — temporadas 2024 y 2025. Para todos los team_id en
// raw_api_payloads que NO estén en `selecciones`. Trae fixtures + statistics +
// events (idempotente), filtrando Women / juveniles / ligas basura. Construye la
// tabla `clubes` (agregado). Background, reanudable por checkpoint, espera al reset
// de cuota si se agota. Rate-limited con backoff en 429.
//
//   setsid nohup node --env-file=.env scripts/backfill-clubes.cjs > /tmp/bf_clubes.log 2>&1 < /dev/null &
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}
const fs = require('fs');
const { Pool } = require('pg');
const HOST = 'v3.football.api-sports.io';
const KEY = process.env.FOOTBALL_API_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 4 });
const CHECKPOINT = '/tmp/bf_clubes_checkpoint.json';
const SEASONS = [2024, 2025];
const QUOTA_SAFETY = 1500; // margen para no pasarse del límite diario

// Ligas basura ya purgadas (no re-insertar) — 26 recientes + 41 previas.
const BLACKLIST = new Set([
  964,612,475,76,266,171,170,347,346,917,570,199,290,542,105,252,285,284,294,114,115,270,257,802,369,1113,
  483,132,517,874,1172,77,624,604,1036,843,477,628,629,627,606,476,972,1022,80,966,924,495,905,891,1171,138,942,943,974,89,90,961,550,555,436,402,560,896,842,1118,1181,
]);
const WOMEN = /women/i;
const YOUTH = /\bU1[0-9]\b|\bU2[0-9]\b|youth|juvenil|sub-?1[0-9]|sub-?2[0-9]/i;
const keepLeague = (lg) => {
  const id = Number(lg?.id); if (BLACKLIST.has(id)) return false;
  const name = lg?.name || ''; if (WOMEN.test(name) || YOUTH.test(name)) return false;
  return true;
};

let callsLocal = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

async function apiGet(path) {
  for (let i = 0; i < 4; i++) {
    try {
      callsLocal++;
      const r = await fetch(`https://${HOST}${path}`, { headers: { 'x-apisports-key': KEY } });
      if (r.status === 429) { await sleep(3000 * (i + 1)); continue; }
      if (!r.ok) return { __http: r.status, response: [] };
      return await r.json();
    } catch (e) { if (i === 3) return { __error: e.message, response: [] }; await sleep(1500 * (i + 1)); }
    await sleep(110);
  }
  return { response: [] };
}
async function quota() {
  const j = await apiGet('/status');
  return { current: j?.response?.requests?.current ?? 0, limit: j?.response?.requests?.limit_day ?? 75000 };
}
async function waitIfQuotaExhausted() {
  const q = await quota();
  if (q.current >= q.limit - QUOTA_SAFETY) {
    const now = new Date();
    const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 2, 0));
    const ms = reset - now;
    log(`CUOTA AGOTADA (${q.current}/${q.limit}). Durmiendo ${Math.round(ms / 60000)} min hasta el reset 00:02 UTC…`);
    await sleep(ms + 5000);
    log('reset alcanzado, continuando.');
  }
}
const existsRaw = async (endpoint, refId, subKey) =>
  (await pool.query(`SELECT 1 FROM raw_api_payloads WHERE endpoint=$1 AND ref_id=$2 AND sub_key=$3`, [endpoint, refId, subKey])).rowCount > 0;

async function upsertClub(teamId) {
  const { rows } = await pool.query(`
    SELECT payload->'league'->>'name' lname, payload->'league'->>'country' lcountry,
           payload->'fixture'->>'date' date, payload->'teams'->'home'->>'id' hid,
           payload->'teams'->'home'->>'name' hname, payload->'teams'->'away'->>'name' aname,
           payload->'teams'->'away'->>'id' aid
    FROM raw_api_payloads WHERE endpoint='fixtures' AND
      ((payload->'teams'->'home'->>'id')::int=$1 OR (payload->'teams'->'away'->>'id')::int=$1)`, [teamId]);
  if (!rows.length) return;
  let name = null; const comps = {}; const countryCount = {}; let first = null, last = null, total = 0;
  for (const r of rows) {
    total++;
    name = Number(r.hid) === teamId ? r.hname : (Number(r.aid) === teamId ? r.aname : name);
    if (r.lname) comps[r.lname] = (comps[r.lname] || 0) + 1;
    if (r.lcountry && r.lcountry !== 'World') countryCount[r.lcountry] = (countryCount[r.lcountry] || 0) + 1;
    const d = (r.date || '').slice(0, 10);
    if (d && (!first || d < first)) first = d;
    if (d && (!last || d > last)) last = d;
  }
  const leaguePrincipal = Object.entries(comps).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const country = Object.entries(countryCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  await pool.query(`
    INSERT INTO clubes (team_id, name, country, league_principal, total_matches, competitions, first_match, last_match, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,NOW())
    ON CONFLICT (team_id) DO UPDATE SET name=EXCLUDED.name, country=EXCLUDED.country, league_principal=EXCLUDED.league_principal,
      total_matches=EXCLUDED.total_matches, competitions=EXCLUDED.competitions, first_match=EXCLUDED.first_match, last_match=EXCLUDED.last_match, updated_at=NOW()`,
    [teamId, name, country, leaguePrincipal, total, JSON.stringify(comps), first, last]);
}

(async () => {
  if (!KEY) throw new Error('FOOTBALL_API_KEY ausente');
  log('=== BACKFILL CLUBES inicio ===');
  await pool.query(`CREATE TABLE IF NOT EXISTS clubes (
    team_id INTEGER PRIMARY KEY, name TEXT, country TEXT, league_principal TEXT,
    total_matches INTEGER NOT NULL DEFAULT 0, competitions JSONB,
    first_match DATE, last_match DATE, updated_at TIMESTAMPTZ DEFAULT NOW())`);

  // clubes = teams en fixtures que NO están en selecciones
  const { rows: clubRows } = await pool.query(`
    SELECT DISTINCT team_id FROM (
      SELECT (payload->'teams'->'home'->>'id')::int team_id FROM raw_api_payloads WHERE endpoint='fixtures'
      UNION SELECT (payload->'teams'->'away'->>'id')::int FROM raw_api_payloads WHERE endpoint='fixtures'
    ) t WHERE team_id IS NOT NULL AND team_id NOT IN (SELECT team_id FROM selecciones) ORDER BY 1`);
  const clubs = clubRows.map(r => Number(r.team_id));
  log(`clubes a procesar: ${clubs.length}`);

  let done = new Set();
  try { done = new Set(JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')).done || []); } catch {}
  log(`checkpoint: ${done.size} ya procesados`);

  let newFixtures = 0, processed = 0;
  for (const cid of clubs) {
    if (done.has(cid)) continue;
    await waitIfQuotaExhausted();
    const fxNew = [];
    for (const season of SEASONS) {
      const resp = await apiGet(`/fixtures?team=${cid}&season=${season}`);
      const arr = Array.isArray(resp?.response) ? resp.response : [];
      for (const f of arr) {
        if (!keepLeague(f?.league)) continue;
        const fid = f?.fixture?.id; if (!fid) continue;
        const ins = await pool.query(`
          INSERT INTO raw_api_payloads (endpoint, ref_type, ref_id, season, sub_key, payload, fetched_at)
          VALUES ('fixtures','fixture',$1,$2,'',$3::jsonb,NOW()) ON CONFLICT (endpoint, ref_id, sub_key) DO NOTHING`,
          [fid, season, JSON.stringify(f)]);
        if (ins.rowCount > 0) { newFixtures++; fxNew.push(fid); }
      }
      await sleep(110);
    }
    // FASE 2: statistics + events de los fixtures NUEVOS de este club
    for (const fid of fxNew) {
      for (const [ep, path] of [['fixtures/statistics', `/fixtures/statistics?fixture=${fid}`], ['fixtures/events', `/fixtures/events?fixture=${fid}`]]) {
        if (await existsRaw(ep, fid, '')) continue;
        const resp = await apiGet(path);
        await pool.query(`INSERT INTO raw_api_payloads (endpoint, ref_type, ref_id, season, sub_key, payload, fetched_at)
          VALUES ($1,'fixture',$2,NULL,'',$3::jsonb,NOW()) ON CONFLICT (endpoint, ref_id, sub_key) DO NOTHING`, [ep, fid, JSON.stringify(resp)]);
        await sleep(110);
      }
    }
    // FASE 3 incremental: actualizar fila del club
    await upsertClub(cid);
    done.add(cid); processed++;
    if (processed % 50 === 0) {
      fs.writeFileSync(CHECKPOINT, JSON.stringify({ done: [...done] }));
      const q = await quota();
      log(`progreso: ${done.size}/${clubs.length} clubes · fixtures nuevos ${newFixtures} · cuota ${q.current}/${q.limit} · llamadas locales ${callsLocal}`);
    }
  }
  fs.writeFileSync(CHECKPOINT, JSON.stringify({ done: [...done] }));
  const { rows: tot } = await pool.query(`SELECT count(*)::int n FROM clubes`);
  log(`=== FIN === clubes en tabla: ${tot[0].n} · fixtures nuevos totales: ${newFixtures} · llamadas locales: ${callsLocal}`);
  await pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
