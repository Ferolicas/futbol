// scripts/model/2d-derive-standings.mjs
// FASE 2D — standings derivados point-in-time (sin fuga) → standings_snapshots
//           + denormaliza rank_before/points_before/matches_remaining en matches.
//   node --env-file=.env.local scripts/model/2d-derive-standings.mjs --only-comp=39 --season=2024  (verificar Premier)
//   node --env-file=.env.local scripts/model/2d-derive-standings.mjs                                (todas las ligas)
// Desempate genérico: puntos → GD → GF → team_id. Solo competiciones con has_table.
import pg from 'pg';

const args = Object.fromEntries(process.argv.slice(2).map(s => { const m = s.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] === '' ? true : m[2]] : [s, true]; }));
const ONLY_COMP = args['only-comp'] ? Number(args['only-comp']) : null;
const ONLY_SEASON = args.season ? Number(args.season) : null;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 3 });
const FINISHED = new Set(['FT', 'AET', 'PEN']);
const POINTS = 3;

function rankTeams(tally) {
  const arr = Object.entries(tally).map(([t, s]) => ({ team: Number(t), ...s }));
  arr.sort((a, b) => b.pts - a.pts || (b.gf - b.ga) - (a.gf - a.ga) || b.gf - a.gf || a.team - b.team);
  const rank = {}; arr.forEach((s, i) => { rank[s.team] = i + 1; }); return rank;
}
async function bulkInsert(c, table, cols, rows) {
  if (!rows.length) return;
  const params = []; const tuples = rows.map(r => `(${cols.map(k => { params.push(r[k]); return `$${params.length}`; }).join(',')})`);
  await c.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}`, params);
}

async function processCompSeason(c, comp, season) {
  const { rows: matches } = await c.query(
    `SELECT fixture_id, home_team_id, away_team_id, kickoff, status, ft_home, ft_away
     FROM model.matches WHERE competition_id=$1 AND season=$2 AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL
     ORDER BY kickoff, fixture_id`, [comp, season]);
  if (!matches.length) return { snaps: 0, matches: 0 };

  // matches_remaining por (fixture, team): partidos del equipo posteriores a éste.
  const teamList = {};
  for (const m of matches) { (teamList[m.home_team_id] ||= []).push(m.fixture_id); (teamList[m.away_team_id] ||= []).push(m.fixture_id); }
  const remaining = {};
  for (const [t, list] of Object.entries(teamList)) list.forEach((fid, i) => { remaining[`${fid}:${t}`] = list.length - i - 1; });

  // agrupar por fecha (UTC) preservando orden
  const byDate = new Map();
  for (const m of matches) { const d = new Date(m.kickoff).toISOString().slice(0, 10); if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push(m); }

  await c.query(`DELETE FROM model.standings_snapshots WHERE competition_id=$1 AND season=$2 AND source='derived'`, [comp, season]);

  const tally = {}; let snaps = 0;
  for (const d of [...byDate.keys()].sort()) {
    const ranked = rankTeams(tally);
    // snapshot ANTES de los partidos de esta fecha (estado de los finalizados previos)
    const snapRows = Object.entries(tally).map(([t, s]) => ({ competition_id: comp, season, team_id: Number(t), as_of_date: d, source: 'derived', played: s.played, won: s.w, drawn: s.d, lost: s.l, gf: s.gf, ga: s.ga, gd: s.gf - s.ga, points: s.pts, rank: ranked[t] }));
    if (snapRows.length) { await bulkInsert(c, 'model.standings_snapshots', Object.keys(snapRows[0]), snapRows); snaps += snapRows.length; }
    // denormalizar rank_before en cada partido de la fecha
    for (const m of byDate.get(d)) {
      await c.query(
        `UPDATE model.matches SET home_rank_before=$2, away_rank_before=$3, home_points_before=$4, away_points_before=$5,
           home_played_before=$6, away_played_before=$7, matches_remaining_home=$8, matches_remaining_away=$9 WHERE fixture_id=$1`,
        [m.fixture_id, ranked[m.home_team_id] ?? null, ranked[m.away_team_id] ?? null,
         tally[m.home_team_id]?.pts ?? 0, tally[m.away_team_id]?.pts ?? 0,
         tally[m.home_team_id]?.played ?? 0, tally[m.away_team_id]?.played ?? 0,
         remaining[`${m.fixture_id}:${m.home_team_id}`] ?? null, remaining[`${m.fixture_id}:${m.away_team_id}`] ?? null]);
    }
    // aplicar los finalizados de la fecha al tally (marcador a 90')
    for (const m of byDate.get(d)) {
      if (!FINISHED.has(m.status)) continue;
      const h = (tally[m.home_team_id] ||= { played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 });
      const a = (tally[m.away_team_id] ||= { played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 });
      const hg = m.ft_home ?? 0, ag = m.ft_away ?? 0;
      h.played++; a.played++; h.gf += hg; h.ga += ag; a.gf += ag; a.ga += hg;
      if (hg > ag) { h.w++; a.l++; h.pts += POINTS; } else if (hg < ag) { a.w++; h.l++; a.pts += POINTS; } else { h.d++; a.d++; h.pts++; a.pts++; }
    }
  }
  return { snaps, matches: matches.length };
}

(async () => {
  let csQuery = `SELECT competition_id, season FROM model.competition_seasons WHERE has_table=true`;
  const p = [];
  if (ONLY_COMP) { p.push(ONLY_COMP); csQuery += ` AND competition_id=$${p.length}`; }
  if (ONLY_SEASON) { p.push(ONLY_SEASON); csQuery += ` AND season=$${p.length}`; }
  csQuery += ` ORDER BY competition_id, season`;
  const { rows: cs } = await pool.query(csQuery, p);
  console.log(`[2D] comp-temporadas con tabla: ${cs.length}`);
  let i = 0, totSnaps = 0, totMatches = 0;
  for (const { competition_id, season } of cs) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await processCompSeason(c, competition_id, season);
      await c.query('COMMIT');
      totSnaps += r.snaps; totMatches += r.matches; i++;
      if (i % 25 === 0 || r.matches > 0) console.log(`  ${i}/${cs.length} comp=${competition_id} season=${season} · partidos=${r.matches} snapshots=${r.snaps}`);
    } catch (e) { await c.query('ROLLBACK'); console.error(`  comp=${competition_id} season=${season} FALLÓ: ${e.message}`); }
    finally { c.release(); }
    await pool.query(`INSERT INTO model.ingest_checkpoint (job,last_ref,processed,total,status,updated_at) VALUES ('derive_standings',$1,$2,$3,'running',now()) ON CONFLICT (job) DO UPDATE SET last_ref=EXCLUDED.last_ref, processed=EXCLUDED.processed, total=EXCLUDED.total, status='running', updated_at=now()`, [competition_id, i, cs.length]);
  }
  await pool.query(`UPDATE model.ingest_checkpoint SET status='done', updated_at=now() WHERE job='derive_standings'`);
  console.log(`[2D] FIN · comp-temporadas=${i} · snapshots=${totSnaps} · partidos con rank_before=${totMatches}`);
  await pool.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
