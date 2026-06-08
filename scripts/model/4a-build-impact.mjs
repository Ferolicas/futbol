// scripts/model/4a-build-impact.mjs
// FASE 4A — full build de model.player_impact (impacto con/sin del jugador en su equipo).
//   node --env-file=.env.local scripts/model/4a-build-impact.mjs            (full: TRUNCATE + rebuild)
//   node --env-file=.env.local scripts/model/4a-build-impact.mjs --only-player=12345
// Set-based; un INSERT con join por rango sobre 1,13M player_match_stats × 98k
// team_match_stats → minutos en full, segundos en incremental.
import pg from 'pg';
import { buildPlayerImpact } from '../../lib/model-impact.js';

const args = Object.fromEntries(process.argv.slice(2).map(s => { const m = s.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] === '' ? true : m[2]] : [s, true]; }));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 3 });

(async () => {
  const t0 = Date.now();
  const playerIds = args['only-player'] ? [Number(args['only-player'])] : null;
  console.log('[4A] player_impact…');
  const r = await buildPlayerImpact(pool, playerIds ? { playerIds } : {});
  console.log(`  player_impact: ${r.written} filas`);
  console.log(`[4A] FIN · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await pool.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
