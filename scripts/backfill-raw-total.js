/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// CLI de la captura cruda total (Camino B). La lógica vive en
// lib/raw-backfill.js (compartida con el cron del worker).
//
//   node --env-file=.env scripts/backfill-raw-total.js --estimate --half=1
//   node --env-file=.env scripts/backfill-raw-total.js --half=1 --run
//   node --env-file=.env scripts/backfill-raw-total.js --half=2 --run   (lo dispara el cron 4am)
//   flags: --with-odds (default off, purgadas), --season=2025, --concurrency=5
// ────────────────────────────────────────────────────────────────────────
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { runRawBackfill } = require('../lib/raw-backfill');

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true]; }));

runRawBackfill({
  half: args.half ? Number(args.half) : null,
  run: !!args.run,
  withOdds: !!args['with-odds'],
  season: args.season ? Number(args.season) : 2025,
  concurrency: args.concurrency ? Number(args.concurrency) : 5,
}).then(() => process.exit(0)).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
