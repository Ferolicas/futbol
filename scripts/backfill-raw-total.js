/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// CLI de la captura cruda total (Camino B). La lógica vive en
// lib/raw-backfill.js (compartida con el cron del worker).
//
//   CLUBES (por mitades):
//     node --env-file=.env scripts/backfill-raw-total.js --estimate --half=1
//     node --env-file=.env scripts/backfill-raw-total.js --half=1 --run
//   SELECCIONES (Mundial — national:true de eliminatorias/Nations/amistosos/continentales):
//     node --env-file=.env scripts/backfill-raw-total.js --selecciones --estimate
//     node --env-file=.env scripts/backfill-raw-total.js --selecciones --run
//   LIGAS DORMIDAS con clubes (Portugal 94, K-League 292, AFC CL 17, CONCACAF 26):
//     node --env-file=.env scripts/backfill-raw-total.js --leagues=94,292,17,26 --run
//   flags: --with-odds, --season=YYYY (historial; default 2025), --team-season, --concurrency=5
// ────────────────────────────────────────────────────────────────────────
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { runRawBackfill, runRawBackfillLeagues, SELECCIONES_LEAGUES } = require('../lib/raw-backfill');

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true]; }));
const run = !!args.run;
const withOdds = !!args['with-odds'];
const concurrency = args.concurrency ? Number(args.concurrency) : 5;
const teamSeason = Number(args['team-season'] || args.season || 2025);

let p;
if (args.selecciones || args.leagues) {
  // Modo por-ligas. --selecciones = preset national. --leagues=a,b,c = arbitrario.
  const leagues = args.leagues ? String(args.leagues).split(',').map(Number) : SELECCIONES_LEAGUES;
  const nationalOnly = args.selecciones ? true : !!args['national-only'];
  p = runRawBackfillLeagues({
    leagues, nationalOnly, run, withOdds, concurrency, teamSeason,
    discoverSeason: args['discover-season'] ? Number(args['discover-season']) : null,
  });
} else {
  // Modo clubes por mitades (match_predictions).
  p = runRawBackfill({
    half: args.half ? Number(args.half) : null,
    run, withOdds, concurrency, season: teamSeason,
  });
}
p.then(() => process.exit(0)).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
