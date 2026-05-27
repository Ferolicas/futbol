/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Paso 1 — Reconstruye team_market_profiles (ADN, para RUNTIME) desde la base
// CRUDA, segmentado (all/home/away/comp:liga/phase:fase) con shrinkage hacia el
// prior de LIGA (no global). Cubre clubes y selecciones.
//
//   node --env-file=.env scripts/build-team-profiles.js
// ────────────────────────────────────────────────────────────────────────
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');
const { ALL_METRICS, RATE_METRICS, recordFromRaw, computeMetrics, shrink, filterSegment } = require('../lib/adn');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});

const PRIOR_RATE = 8, PRIOR_AVG = 6;
const MIN_SEG_RECORDS = 3;  // comp/phase: solo segmentos con suficiente muestra
const round4 = (v) => v == null ? null : Math.round(v * 10000) / 10000;

(async () => {
  console.log('\nCargando crudos (fixtures + statistics)…');
  const { rows: fxRows } = await pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='fixtures'`);
  const { rows: stRows } = await pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='fixtures/statistics'`);
  const stats = new Map(stRows.map(r => [Number(r.ref_id), r.payload]));
  console.log(`  fixtures=${fxRows.length} · statistics=${stRows.length}`);

  // Registros por equipo + por liga + global.
  const teamRecs = new Map();   // teamId -> [rec]
  const leagueRecs = new Map(); // leagueId -> [rec]
  const allRecs = [];
  for (const row of fxRows) {
    const f = row.payload;
    const st = stats.get(Number(f?.fixture?.id)) || null;
    for (const tid of [f?.teams?.home?.id, f?.teams?.away?.id]) {
      if (!tid) continue;
      const rec = recordFromRaw(f, st, tid);
      if (!rec) continue;
      if (!teamRecs.has(tid)) teamRecs.set(tid, []);
      teamRecs.get(tid).push(rec);
      if (rec.leagueId) { if (!leagueRecs.has(rec.leagueId)) leagueRecs.set(rec.leagueId, []); leagueRecs.get(rec.leagueId).push(rec); }
      allRecs.push(rec);
    }
  }
  console.log(`  equipos=${teamRecs.size} · registros=${allRecs.length}`);

  // Priors: global + por liga (sobre TODOS los registros de la liga).
  const globalPrior = computeMetrics(allRecs);
  const leaguePrior = new Map();
  for (const [lid, recs] of leagueRecs) leaguePrior.set(lid, computeMetrics(recs));
  const priorVal = (lid, metric) =>
    leaguePrior.get(lid)?.[metric]?.emp ?? globalPrior[metric]?.emp ?? null;

  // Construir filas.
  const rowsOut = [];
  for (const [teamId, recs] of teamRecs) {
    // Liga primaria = la de más partidos.
    const lidCount = {};
    for (const r of recs) if (r.leagueId) lidCount[r.leagueId] = (lidCount[r.leagueId] || 0) + 1;
    const primaryLid = Number(Object.entries(lidCount).sort((a, b) => b[1] - a[1])[0]?.[0]) || null;

    // Segmentos: base + comp/phase con muestra suficiente.
    const segments = ['all', 'home', 'away'];
    for (const [lid, c] of Object.entries(lidCount)) if (c >= MIN_SEG_RECORDS) segments.push(`comp:${lid}`);
    const phaseCount = {};
    for (const r of recs) phaseCount[r.phase] = (phaseCount[r.phase] || 0) + 1;
    for (const [ph, c] of Object.entries(phaseCount)) if (c >= MIN_SEG_RECORDS && ph !== 'regular') segments.push(`phase:${ph}`);

    for (const seg of segments) {
      const segRecs = filterSegment(recs, seg);
      if (segRecs.length < 2) continue;
      const metrics = computeMetrics(segRecs);
      const priorLid = seg.startsWith('comp:') ? Number(seg.slice(5)) : primaryLid;
      for (const metric of ALL_METRICS) {
        const m = metrics[metric];
        if (!m || m.n < 2) continue;
        const k = RATE_METRICS.includes(metric) ? PRIOR_RATE : PRIOR_AVG;
        const shrunk = shrink(m.emp, m.n, priorVal(priorLid, metric), k);
        rowsOut.push([teamId, metric, seg, m.n, round4(m.emp), round4(shrunk), round4(m.n / (m.n + k))]);
      }
    }
  }
  console.log(`  filas a escribir: ${rowsOut.length}`);

  // Upsert por lotes.
  const CHUNK = 500;
  for (let i = 0; i < rowsOut.length; i += CHUNK) {
    const chunk = rowsOut.slice(i, i + CHUNK);
    const vals = [], params = [];
    chunk.forEach((r, j) => {
      const b = j * 7;
      vals.push(`('football',$${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},NOW())`);
      params.push(r[0], r[1], r[2], r[3], r[4], r[5], r[6]);
    });
    await pool.query(
      `INSERT INTO team_market_profiles (sport, team_id, metric, segment, sample_n, emp_value, shrunk_value, consistency, updated_at)
       VALUES ${vals.join(',')}
       ON CONFLICT (sport, team_id, metric, segment)
       DO UPDATE SET sample_n=EXCLUDED.sample_n, emp_value=EXCLUDED.emp_value, shrunk_value=EXCLUDED.shrunk_value, consistency=EXCLUDED.consistency, updated_at=NOW()`,
      params
    );
  }
  console.log(`\n✓ team_market_profiles reconstruido: ${rowsOut.length} filas, ${teamRecs.size} equipos (segmentos all/home/away/comp/phase, prior de liga).`);
  await pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
