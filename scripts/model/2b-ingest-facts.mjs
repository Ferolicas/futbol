// scripts/model/2b-ingest-facts.mjs
// FASE 2B — ingesta de hechos del crudo → schema model. CLI delgada sobre
// lib/model-ingest.js (FUENTE ÚNICA de la lógica, compartida con la nocturna 2E).
//   node --env-file=.env.local scripts/model/2b-ingest-facts.mjs --only-team=290   (verificación)
//   node --env-file=.env.local scripts/model/2b-ingest-facts.mjs --resume          (backfill completo, reanudable)
import pg from 'pg';
import { ingestFixtures } from '../../lib/model-ingest.js';

const args = Object.fromEntries(process.argv.slice(2).map(s => { const m = s.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] === '' ? true : m[2]] : [s, true]; }));
const BATCH = Number(args.batch) || 400;
const ONLY_TEAM = args['only-team'] ? Number(args['only-team']) : null;
const LIMIT = args.limit ? Number(args.limit) : null;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 4 });

(async () => {
  const teamFilter = ONLY_TEAM ? `AND (payload->'teams'->'home'->>'id'='${ONLY_TEAM}' OR payload->'teams'->'away'->>'id'='${ONLY_TEAM}')` : '';
  if (args.reset) await pool.query(`DELETE FROM model.ingest_checkpoint WHERE job='ingest_facts'`);
  let last = 0;
  if (args.resume) { const { rows } = await pool.query(`SELECT last_ref FROM model.ingest_checkpoint WHERE job='ingest_facts'`); last = Number(rows[0]?.last_ref || 0); }
  const { rows: [{ total }] } = await pool.query(`SELECT count(*)::bigint total FROM raw_api_payloads WHERE endpoint='fixtures' AND sub_key='' ${teamFilter}`);
  console.log(`[2B] fixtures a procesar: ${total} · batch=${BATCH} · resume desde ref_id>${last}${ONLY_TEAM ? ` · solo equipo ${ONLY_TEAM}` : ''}`);

  let done = 0, withStats = 0, withPlayers = 0;
  for (;;) {
    const { rows } = await pool.query(`SELECT ref_id FROM raw_api_payloads WHERE endpoint='fixtures' AND sub_key='' AND ref_id>$1 ${teamFilter} ORDER BY ref_id LIMIT $2`, [last, BATCH]);
    if (!rows.length) break;
    const fids = rows.map(r => Number(r.ref_id));
    const r = await ingestFixtures(pool, fids, { batch: BATCH });
    done += r.done; withStats += r.withStats; withPlayers += r.withPlayers; last = fids[fids.length - 1];
    await pool.query(`INSERT INTO model.ingest_checkpoint (job,last_ref,processed,total,status,updated_at) VALUES ('ingest_facts',$1,$2,$3,'running',now()) ON CONFLICT (job) DO UPDATE SET last_ref=EXCLUDED.last_ref, processed=EXCLUDED.processed, total=EXCLUDED.total, status='running', updated_at=now()`, [last, done, total]);
    console.log(`  ${done}/${total} · conStats=${withStats} conPlayers=${withPlayers} · últimoFid=${last}`);
    if (LIMIT && done >= LIMIT) break;
  }
  await pool.query(`UPDATE model.ingest_checkpoint SET status='done', updated_at=now() WHERE job='ingest_facts'`);
  console.log(`[2B] FIN · procesados=${done} · conStats=${withStats} · conPlayers=${withPlayers}`);
  await pool.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
