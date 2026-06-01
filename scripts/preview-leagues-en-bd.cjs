/* eslint-disable */
// Lista de TODAS las ligas presentes en raw_api_payloads (fixtures), con su
// nombre, país, # clubes únicos, # partidos. Indica si está en la whitelist.
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}
const { Pool } = require('pg');
const p = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});
const WHITELIST = new Set([39,40,41,140,141,78,79,135,136,61,62,203,88,94,181,103,113,333,345,283,262,239,240,128,71,253,265,281,268,250]);
(async () => {
  const { rows } = await p.query(`
    SELECT
      (payload->'league'->>'id')::int AS lid,
      payload->'league'->>'name' AS lname,
      payload->'league'->>'country' AS country,
      count(*) AS partidos,
      count(DISTINCT (payload->'teams'->'home'->>'id')) +
        count(DISTINCT (payload->'teams'->'away'->>'id')) AS equipos_aprox
    FROM raw_api_payloads
    WHERE endpoint='fixtures'
    GROUP BY 1,2,3
    ORDER BY country NULLS LAST, partidos DESC
  `);
  console.log('id\tWL\tpais\t\t\tpartidos\tnombre');
  console.log('-'.repeat(110));
  let cur = null;
  for (const r of rows) {
    if (r.country !== cur) { console.log(''); cur = r.country; }
    const wl = WHITELIST.has(r.lid) ? '✓' : ' ';
    console.log(`${String(r.lid).padEnd(6)}\t${wl}\t${(r.country || '-').padEnd(20)}\t${String(r.partidos).padStart(6)}\t\t${r.lname}`);
  }
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
