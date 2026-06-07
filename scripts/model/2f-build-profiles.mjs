// scripts/model/2f-build-profiles.mjs
// FASE 2F — full build de team_profiles + player_profiles desde los hechos.
//   node --env-file=.env.local scripts/model/2f-build-profiles.mjs            (full: TRUNCATE + rebuild)
//   node --env-file=.env.local scripts/model/2f-build-profiles.mjs --only-team=290
//   node --env-file=.env.local scripts/model/2f-build-profiles.mjs --only-player=12345
// Set-based (GROUP BY); 98k team_match_stats + 1,13M player_match_stats → ~minutos.
import pg from 'pg';
import { buildTeamProfiles, buildPlayerProfiles } from '../../lib/model-profiles.js';

const args = Object.fromEntries(process.argv.slice(2).map(s => { const m = s.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] === '' ? true : m[2]] : [s, true]; }));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 3 });

(async () => {
  const t0 = Date.now();
  const teamIds = args['only-team'] ? [Number(args['only-team'])] : null;
  const playerIds = args['only-player'] ? [Number(args['only-player'])] : null;
  console.log('[2F] team_profiles…');
  const t = await buildTeamProfiles(pool, teamIds ? { teamIds } : {});
  console.log(`  team_profiles: ${t.written} filas`);
  console.log('[2F] player_profiles…');
  const p = await buildPlayerProfiles(pool, playerIds ? { playerIds } : {});
  console.log(`  player_profiles: ${p.written} filas`);
  console.log(`[2F] FIN · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await pool.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
