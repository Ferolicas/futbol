// scripts/model/_tmp_pm_real.mjs — prueba REAL de buildPlayerMarkets sobre el fixture 1548445.
//   node --env-file=.env scripts/model/_tmp_pm_real.mjs
import pg from 'pg';
import { buildPlayerMarkets } from '../../lib/model-player-markets.js';

const FIX = 1548445;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 3 });

(async () => {
  // (1) startXI real confirmado + nombre
  const { rows: lu } = await pool.query(
    `SELECT lu.player_id, lu.team_id, p.name
     FROM model.lineups lu LEFT JOIN model.players p USING(player_id)
     WHERE lu.fixture_id = $1 AND lu.is_starter = true`, [FIX]);
  // (2) kickoff del fixture → cutoff point-in-time
  const { rows: mm } = await pool.query(`SELECT kickoff, home_team_id, away_team_id FROM model.matches WHERE fixture_id = $1`, [FIX]);
  if (!mm.length) { console.error(`fixture ${FIX} no está en model.matches`); await pool.end(); process.exit(1); }
  const cutoff = new Date(mm[0].kickoff);
  const startXI = lu.map(r => ({ player_id: Number(r.player_id), team_id: Number(r.team_id), name: r.name }));
  console.log(`fixture ${FIX} · startXI confirmado: ${startXI.length} titulares · cutoff(kickoff)=${cutoff.toISOString()}`);

  // (3) mercados de jugador
  const out = await buildPlayerMarkets(pool, startXI, { cutoff });

  // (4) resumen + 3 jugadores con líneas completas
  const withMkt = Object.keys(out).length;
  console.log(`con mercado: ${withMkt}/${startXI.length}  ·  sin mercado (muestra <PM_MIN_N o sin historial): ${startXI.length - withMkt}`);
  const sinMkt = startXI.filter(p => !out[p.player_id]).map(p => `${p.player_id}${p.name ? '(' + p.name + ')' : ''}`);
  if (sinMkt.length) console.log(`filtrados: ${sinMkt.join(', ')}`);

  const sample = Object.values(out).slice(0, 3);
  for (const p of sample) {
    console.log(`\n— ${p.name || p.player_id} (id=${p.player_id}, n=${p.n} apariciones) —`);
    const m = p.markets;
    if (m.anytime_scorer) console.log(`  anytime goleador: ${(m.anytime_scorer.prob * 100).toFixed(1)}%  [n${m.anytime_scorer.n} conf=${m.anytime_scorer.conf}]`);
    if (m.to_be_carded)   console.log(`  tarjeta:          ${(m.to_be_carded.prob * 100).toFixed(1)}%  [n${m.to_be_carded.n} conf=${m.to_be_carded.conf}]`);
    for (const k of ['shots', 'shots_on', 'fouls']) {
      if (!m[k]) continue;
      console.log(`  ${k.padEnd(9)} ${m[k].lines.map(l => `o${l.line}:${(l.prob * 100).toFixed(1)}%`).join('  ')}`);
    }
  }
  await pool.end();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
