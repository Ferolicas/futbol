/* eslint-disable */
// Reingiere únicamente fixtures cuyos crudos relacionados fueron reparados
// desde una fecha. Dry-run por defecto; --run aplica model-ingest idempotente.

try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');
const { ingestFixtures } = require('../lib/model-ingest.js');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const RUN = !!args.run;
const MISSING_PLAYER_FACTS = !!args['missing-player-facts'];
const FIXTURE_IDS = String(args['fixture-ids'] || '')
  .split(',').map((value) => Number(value.trim())).filter((value) => Number.isSafeInteger(value) && value > 0);
const SINCE = args.since ? new Date(String(args.since)) : new Date(Date.now() - 24 * 3600 * 1000);
const BASE_SINCE = args['base-since'] ? new Date(String(args['base-since'])) : null;
const CONCURRENCY = Math.max(1, Math.min(4, Number(args.concurrency || 3)));
const CHUNK = Math.max(50, Number(args.chunk || 300));
if (!Number.isFinite(SINCE.getTime())) throw new Error('--since debe ser una fecha ISO válida');
if (BASE_SINCE && !Number.isFinite(BASE_SINCE.getTime())) throw new Error('--base-since debe ser una fecha ISO válida');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: CONCURRENCY + 2,
});

async function mapPool(items, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; await fn(items[index], index); }
  }));
}

(async () => {
  let counts;
  let rows;
  let modeLabel;
  if (FIXTURE_IDS.length) {
    rows = [...new Set(FIXTURE_IDS)].sort((a, b) => a - b).map((fixture_id) => ({ fixture_id }));
    counts = [{ endpoint: 'explicit-fixtures', n: rows.length, fixtures: rows.length }];
    modeLabel = 'fixture-ids';
  } else if (MISSING_PLAYER_FACTS) {
    const missingSql = `
      WITH played AS (
        SELECT DISTINCT r.ref_id::bigint AS fixture_id,
               NULLIF(pl#>>'{player,id}', '')::bigint AS player_id
        FROM raw_api_payloads r
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(r.payload->'response')='array'
               THEN r.payload->'response' ELSE '[]'::jsonb END
        ) tb
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(tb->'players')='array'
               THEN tb->'players' ELSE '[]'::jsonb END
        ) pl
        WHERE r.endpoint='fixtures/players' AND r.sub_key=''
          AND NULLIF(pl#>>'{player,id}', '')::numeric > 0
          AND NULLIF(pl#>>'{statistics,0,games,minutes}', '')::numeric > 0
      ), missing AS (
        SELECT p.fixture_id,p.player_id
        FROM played p
        LEFT JOIN model.player_match_stats m
          ON m.fixture_id=p.fixture_id AND m.player_id=p.player_id
        WHERE m.player_id IS NULL
      )`;
    ({ rows: counts } = await pool.query(
      `${missingSql}
       SELECT 'fixtures/players-missing-facts'::text endpoint,
              count(*)::int n,count(DISTINCT fixture_id)::int fixtures
       FROM missing`));
    ({ rows } = await pool.query(
      `${missingSql}
       SELECT DISTINCT fixture_id FROM missing ORDER BY fixture_id`));
    modeLabel = 'missing-player-facts';
  } else {
    const effectiveSince = BASE_SINCE || SINCE;
    const params = [effectiveSince.toISOString()];
    const predicate = BASE_SINCE
      ? `fetched_at >= $1::timestamptz AND endpoint='fixtures' AND sub_key=''`
      : `fetched_at >= $1::timestamptz AND (
          endpoint IN ('fixtures/statistics','fixtures/events','fixtures/players','fixtures/lineups','fixtures/halfstats')
          OR (endpoint='injuries' AND sub_key LIKE 'fx:%')
        )`;
    ({ rows: counts } = await pool.query(
      `SELECT endpoint,count(*)::int n,count(DISTINCT ref_id)::int fixtures
       FROM raw_api_payloads WHERE ${predicate} GROUP BY endpoint ORDER BY endpoint`, params));
    ({ rows } = await pool.query(
      `SELECT DISTINCT ref_id::bigint AS fixture_id FROM raw_api_payloads
       WHERE ${predicate} ORDER BY fixture_id`, params));
    modeLabel = `${BASE_SINCE ? 'base-since' : 'since'}=${effectiveSince.toISOString()}`;
  }
  const ids = rows.map((row) => Number(row.fixture_id)).filter(Boolean);
  console.log(`[reingest-repaired] ${modeLabel} · fixtures únicos=${ids.length}`);
  for (const row of counts) console.log(`  ${row.endpoint}: payloads=${row.n} fixtures=${row.fixtures}`);
  if (!RUN) {
    console.log('Dry-run. Añade --run para reingerirlos.');
    await pool.end();
    return;
  }

  const chunks = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  const total = { done: 0, failed: 0, missingFixtureRaw: 0, withStats: 0, withPlayers: 0 };
  let completed = 0;
  await mapPool(chunks, CONCURRENCY, async (chunk) => {
    const result = await ingestFixtures(pool, chunk, { batch: CHUNK });
    for (const key of Object.keys(total)) total[key] += Number(result[key] || 0);
    completed += chunk.length;
    console.log(`  ${completed}/${ids.length} · ok=${total.done} fail=${total.failed} sinFixture=${total.missingFixtureRaw}`);
  });
  console.log(`[reingest-repaired] FIN ${JSON.stringify(total)}`);
  if (total.failed || total.missingFixtureRaw) process.exitCode = 2;
  await pool.end();
})().catch(async (error) => {
  console.error('[reingest-repaired] FATAL', error?.message || error);
  await pool.end().catch(() => {});
  process.exit(1);
});
