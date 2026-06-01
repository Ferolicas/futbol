/* eslint-disable */
// PREVIEW (NO BORRA) — equipos a eliminar: total_matches < 30 que NO han jugado
// en ninguna liga importante de 1ª/2ª división de Europa/América/Oceanía.
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}
const { Pool } = require('pg');
const p = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

// Whitelist: ligas importantes 1ª/2ª de Europa + América + Oceanía (NO Asia, NO África)
const WHITELIST = [
  39, 40, 41,         // England (PL, Champ, L1)
  140, 141,           // Spain (LaLiga, LaLiga 2)
  78, 79,             // Germany (Bundesliga, 2.Bundes)
  135, 136,           // Italy (Serie A, B)
  61, 62,             // France (Ligue 1, 2)
  203,                // Turkey Süper Lig (UEFA)
  88,                 // Netherlands Eredivisie
  94,                 // Portugal Primeira
  181,                // Scotland Championship
  103,                // Norway Eliteserien
  113,                // Sweden Allsvenskan
  333,                // Ukraine Premier
  345,                // Czech Liga
  283,                // Romania Liga I
  262,                // Mexico Liga MX
  239, 240,           // Colombia BetPlay 1, 2
  128,                // Argentina Liga Profesional
  71,                 // Brazil Brasileirão A
  253,                // USA MLS
  265,                // Chile Primera
  281,                // Peru Liga 1
  268,                // Uruguay Primera
  250,                // Paraguay Profesional
];

(async () => {
  const SQL_CANDIDATES = `
    WITH club_lg AS (
      SELECT c.team_id, c.name, c.country, c.league_principal, c.total_matches,
        ARRAY(
          SELECT DISTINCT (rap.payload->'league'->>'id')::int
          FROM raw_api_payloads rap
          WHERE rap.endpoint='fixtures'
            AND ( (rap.payload->'teams'->'home'->>'id')::int = c.team_id
               OR (rap.payload->'teams'->'away'->>'id')::int = c.team_id )
        ) AS lids
      FROM clubes c
      WHERE c.total_matches < 30
    )
    SELECT team_id, name, country, league_principal, total_matches, lids
    FROM club_lg
    WHERE NOT (lids && $1::int[])
    ORDER BY total_matches DESC, country NULLS LAST, name
  `;
  const totClub = (await p.query(`SELECT count(*)::int n FROM clubes`)).rows[0].n;
  const totSub30 = (await p.query(`SELECT count(*)::int n FROM clubes WHERE total_matches<30`)).rows[0].n;
  const cand = await p.query(SQL_CANDIDATES, [WHITELIST]);
  const protegidos = totSub30 - cand.rows.length;

  console.log('================================================');
  console.log('clubes en BD                :', totClub);
  console.log('clubes con <30 partidos     :', totSub30);
  console.log('  protegidos por whitelist  :', protegidos);
  console.log('  A ELIMINAR (no en whitel) :', cand.rows.length);
  console.log('================================================');

  // distribución por country
  const byC = {};
  for (const r of cand.rows) {
    const k = r.country || '(null)';
    byC[k] = (byC[k] || 0) + 1;
  }
  console.log('\n=== A ELIMINAR · por país ===');
  Object.entries(byC).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k}`));

  // top 50 por partidos (más arriba) y bottom 30 (más abajo)
  console.log('\n=== A ELIMINAR · TOP 50 (los más partidos, candidatos más “gordos”) ===');
  console.log('team_id\tpartidos\tpaís\t\tliga_principal\t\tnombre');
  for (const r of cand.rows.slice(0, 50)) {
    console.log(`${r.team_id}\t${r.total_matches}\t\t${(r.country || '-').slice(0,12).padEnd(12)}\t${(r.league_principal || '-').slice(0,28).padEnd(28)}\t${r.name}`);
  }
  console.log('\n=== A ELIMINAR · BOTTOM 30 (los más chicos, 1-3 partidos) ===');
  for (const r of cand.rows.slice(-30)) {
    console.log(`${r.team_id}\t${r.total_matches}\t\t${(r.country || '-').slice(0,12).padEnd(12)}\t${(r.league_principal || '-').slice(0,28).padEnd(28)}\t${r.name}`);
  }

  // CSV completo a archivo para revisión total
  const fs = require('fs');
  const csv = ['team_id,partidos,country,league_principal,name,league_ids'];
  for (const r of cand.rows) {
    const esc = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
    csv.push(`${r.team_id},${r.total_matches},${esc(r.country)},${esc(r.league_principal)},${esc(r.name)},${esc((r.lids || []).join('|'))}`);
  }
  fs.writeFileSync('/tmp/clubes_a_eliminar.csv', csv.join('\n'));
  console.log('\nCSV completo: /tmp/clubes_a_eliminar.csv');

  await p.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
