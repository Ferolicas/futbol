/* eslint-disable */
// Backfill de SELECCIONES (absoluta masculina) — últimos ~8-10 años, TODAS las
// competiciones de selección: mundial, eurocopa, copas continentales, eliminatorias,
// nations leagues, amistosos. Persiste crudo COMPLETO en raw_api_payloads (fixtures +
// statistics + events) en el MISMO formato que el modelo consume, y construye la tabla
// `selecciones` (una fila por selección). Idempotente (ON CONFLICT). Rate-limited.
//
//   node --env-file=.env scripts/backfill-selecciones.cjs
// Pensado para correr en background:  setsid nohup node --env-file=.env scripts/backfill-selecciones.cjs > /tmp/bf_sel.log 2>&1 &
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}
const { Pool } = require('pg');
const HOST = 'v3.football.api-sports.io';
const KEY = process.env.FOOTBALL_API_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 4 });

// Competiciones de SELECCIÓN absoluta masculina → temporadas (≥2017). Excluye
// femeninas, juveniles (U17/U20/U23) y Kings League.
const COMPS = {
  1:  [2018, 2022, 2026],                       // World Cup
  4:  [2020, 2024],                             // Euro Championship
  960:[2019, 2023],                             // Euro Qualification
  9:  [2019, 2021, 2024],                       // Copa America
  6:  [2017, 2019, 2021, 2023, 2025],           // Africa Cup of Nations
  36: [2019, 2021, 2023, 2025],                 // ACN Qualification
  7:  [2019, 2023],                             // Asian Cup
  35: [2019, 2022, 2024],                       // Asian Cup Qualification
  22: [2017, 2019, 2021, 2023, 2025],           // CONCACAF Gold Cup
  858:[2021, 2023, 2025],                        // Gold Cup Qualification
  5:  [2018, 2020, 2022, 2024],                 // UEFA Nations League
  536:[2019, 2020, 2022, 2023, 2024],           // CONCACAF Nations League
  808:[2018, 2019],                             // CONCACAF NL Qualification
  21: [2017],                                   // Confederations Cup
  913:[2022],                                   // Finalissima
  860:[2021, 2025],                             // Arab Cup
  1008:[2023, 2025],                            // CAFA Nations Cup
  859:[2021, 2022, 2023, 2024, 2025],           // COSAFA Cup
  806:[2024],                                   // OFC Nations Cup
  916:[2022],                                   // Kirin Cup
  504:[2017, 2018, 2019, 2022],                 // King's Cup
  1038:[2023, 2024, 2025],                       // King's Cup
  // World Cup Qualification por confederación
  32: [2018, 2020, 2024],   // Europe
  34: [2018, 2022, 2026],   // South America
  30: [2018, 2022, 2026],   // Asia
  29: [2018, 2022, 2023],   // Africa
  31: [2018, 2022, 2026],   // CONCACAF
  33: [2018, 2022, 2026],   // Oceania
  37: [2018, 2022, 2026],   // Intercontinental Play-offs
  10: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026], // Friendlies
};
// Confederación por competición (para la columna confederation de selecciones).
const CONF = {
  4:'UEFA',960:'UEFA',5:'UEFA',32:'UEFA',
  9:'CONMEBOL',34:'CONMEBOL',913:'CONMEBOL/UEFA',
  6:'CAF',36:'CAF',859:'CAF',29:'CAF',
  7:'AFC',35:'AFC',30:'AFC',860:'AFC',1008:'AFC',916:'AFC',504:'AFC',1038:'AFC',
  22:'CONCACAF',858:'CONCACAF',536:'CONCACAF',808:'CONCACAF',31:'CONCACAF',
  806:'OFC',33:'OFC',
};

let calls = 0, saved = 0, skipped = 0, errors = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function apiGet(path) {
  for (let i = 0; i < 4; i++) {
    try {
      calls++;
      const r = await fetch(`https://${HOST}${path}`, { headers: { 'x-apisports-key': KEY } });
      if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (!r.ok) return { __http: r.status, response: [] };
      return await r.json();
    } catch (e) { if (i === 3) { errors++; return { __error: e.message, response: [] }; } await sleep(1000 * (i + 1)); }
    await sleep(90);
  }
  return { response: [] };
}
async function existsRaw(endpoint, refId, subKey) {
  const { rows } = await pool.query(`SELECT 1 FROM raw_api_payloads WHERE endpoint=$1 AND ref_id=$2 AND sub_key=$3`, [endpoint, refId, subKey]);
  return rows.length > 0;
}

(async () => {
  if (!KEY) throw new Error('FOOTBALL_API_KEY no está en el env');
  const t0 = Date.now();
  console.log(`[bf-sel] inicio ${new Date().toISOString()}`);

  // ── FASE 1: fixtures de cada (competición, temporada) ──
  const fixtureIds = new Set();
  const teamComp = new Map(); // teamId -> { name, comps:Map(compName->count), confs:Set, first, last, total }
  const compEntries = Object.entries(COMPS);
  for (const [lid, seasons] of compEntries) {
    for (const y of seasons) {
      const resp = await apiGet(`/fixtures?league=${lid}&season=${y}`);
      const arr = Array.isArray(resp?.response) ? resp.response : [];
      for (const f of arr) {
        const fid = f?.fixture?.id; if (!fid) continue;
        await pool.query(
          `INSERT INTO raw_api_payloads (endpoint, ref_type, ref_id, season, sub_key, payload, fetched_at)
           VALUES ('fixtures','fixture',$1,$2,'',$3::jsonb,NOW())
           ON CONFLICT (endpoint, ref_id, sub_key) DO UPDATE SET payload=EXCLUDED.payload, fetched_at=NOW()`,
          [fid, y, JSON.stringify(f)]);
        fixtureIds.add(fid);
        const lname = f?.league?.name || `league ${lid}`;
        const date = (f?.fixture?.date || '').slice(0, 10);
        for (const side of ['home', 'away']) {
          const tid = f?.teams?.[side]?.id, tname = f?.teams?.[side]?.name;
          if (!tid) continue;
          if (!teamComp.has(tid)) teamComp.set(tid, { name: tname, comps: new Map(), confs: new Set(), first: date, last: date, total: 0 });
          const t = teamComp.get(tid);
          if (tname) t.name = tname;
          t.comps.set(lname, (t.comps.get(lname) || 0) + 1);
          if (CONF[lid]) t.confs.add(CONF[lid]);
          t.total++;
          if (date && (!t.first || date < t.first)) t.first = date;
          if (date && (!t.last || date > t.last)) t.last = date;
        }
      }
      await sleep(90);
    }
    console.log(`[bf-sel][fase1] liga ${lid} hecha · fixtures acumulados ${fixtureIds.size} · llamadas ${calls}`);
  }
  console.log(`[bf-sel] FASE1 done: ${fixtureIds.size} fixtures, ${teamComp.size} selecciones, ${calls} llamadas, ${Math.round((Date.now()-t0)/1000)}s`);

  // ── FASE 2: tabla selecciones ──
  await pool.query(`CREATE TABLE IF NOT EXISTS selecciones (
    team_id bigint PRIMARY KEY, name text, confederation text,
    total_matches int, competitions jsonb, first_match date, last_match date, updated_at timestamptz DEFAULT NOW())`);
  for (const [tid, t] of teamComp) {
    const comps = Object.fromEntries([...t.comps.entries()].sort((a, b) => b[1] - a[1]));
    await pool.query(
      `INSERT INTO selecciones (team_id, name, confederation, total_matches, competitions, first_match, last_match, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,NOW())
       ON CONFLICT (team_id) DO UPDATE SET name=EXCLUDED.name, confederation=EXCLUDED.confederation,
         total_matches=EXCLUDED.total_matches, competitions=EXCLUDED.competitions,
         first_match=EXCLUDED.first_match, last_match=EXCLUDED.last_match, updated_at=NOW()`,
      [tid, t.name, [...t.confs].join('/') || null, t.total, JSON.stringify(comps), t.first || null, t.last || null]);
  }
  console.log(`[bf-sel] FASE2 done: tabla selecciones poblada con ${teamComp.size} selecciones`);

  // ── FASE 3: statistics + events por fixture (idempotente) ──
  const ids = [...fixtureIds];
  let done = 0;
  for (const fid of ids) {
    for (const [endpoint, path] of [['fixtures/statistics', `/fixtures/statistics?fixture=${fid}`], ['fixtures/events', `/fixtures/events?fixture=${fid}`]]) {
      if (await existsRaw(endpoint, fid, '')) { skipped++; continue; }
      const resp = await apiGet(path);
      await pool.query(
        `INSERT INTO raw_api_payloads (endpoint, ref_type, ref_id, season, sub_key, payload, fetched_at)
         VALUES ($1,'fixture',$2,NULL,'',$3::jsonb,NOW()) ON CONFLICT (endpoint, ref_id, sub_key) DO NOTHING`,
        [endpoint, fid, JSON.stringify(resp)]);
      saved++;
      await sleep(90);
    }
    if (++done % 200 === 0) console.log(`[bf-sel][fase3] ${done}/${ids.length} fixtures · llamadas ${calls} · saved ${saved} · skip ${skipped} · ${Math.round((Date.now()-t0)/1000)}s`);
  }
  console.log(`[bf-sel] FASE3 done: statistics+events. llamadas totales ${calls}, saved ${saved}, skip ${skipped}, errores ${errors}`);
  console.log(`[bf-sel] FIN ${new Date().toISOString()} · total ${Math.round((Date.now()-t0)/1000)}s`);
  await pool.end();
})().catch(e => { console.error('[bf-sel] FATAL:', e.message); process.exit(1); });
