/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Seed de equipos_mlb (30 equipos MLB activos).
//
// Trae el catálogo oficial desde MLB Stats API (statsapi.mlb.com/api/v1/teams
// ?sportId=1) y le inyecta el park_factor de cada estadio (constantes
// hardcodeadas por team_id MLB — fuente: FanGraphs/Baseball Reference,
// promedio reciente). Idempotente: ON CONFLICT actualiza siempre nombre,
// división, venue y park_factor.
//
// Ejecutar en el VPS (o local con DATABASE_URL apuntando al VPS):
//   node --env-file=.env scripts/seed-equipos-mlb.js [--season=2026]
// ────────────────────────────────────────────────────────────────────────

try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');

const SEASON = (() => {
  const arg = process.argv.find(a => a.startsWith('--season='));
  return arg ? Number(arg.split('=')[1]) : new Date().getFullYear();
})();

// team_id MLB Stats API → park_factor del estadio. Cualquier id no presente
// (afiliados MiLB, equipos disueltos) queda con 1.0 por DEFAULT de la tabla.
const PARK_FACTORS = {
  108: 0.99,  // LAA  Angel Stadium
  109: 1.02,  // ARI  Chase Field
  110: 1.03,  // BAL  Camden Yards
  111: 1.08,  // BOS  Fenway Park
  112: 1.05,  // CHC  Wrigley Field
  113: 1.10,  // CIN  Great American Ball Park
  114: 0.97,  // CLE  Progressive Field
  115: 1.18,  // COL  Coors Field
  116: 0.97,  // DET  Comerica Park
  117: 1.01,  // HOU  Minute Maid Park
  118: 0.95,  // KC   Kauffman Stadium
  119: 0.99,  // LAD  Dodger Stadium
  120: 0.98,  // WAS  Nationals Park
  121: 1.00,  // NYM  Citi Field
  133: 0.91,  // OAK/ATH Oakland Coliseum (valor histórico); en 2025+ Athletics
              //         juegan en Sutter Health Park (Sacramento) — refinar
              //         park factor cuando haya muestra suficiente.
  134: 0.96,  // PIT  PNC Park
  135: 0.90,  // SD   Petco Park
  136: 0.92,  // SEA  T-Mobile Park
  137: 0.93,  // SF   Oracle Park
  138: 0.96,  // STL  Busch Stadium
  139: 0.91,  // TB   Tropicana Field
  140: 1.07,  // TEX  Globe Life Field
  141: 1.00,  // TOR  Rogers Centre
  142: 0.97,  // MIN  Target Field
  143: 1.04,  // PHI  Citizens Bank Park
  144: 1.04,  // ATL  Truist Park
  145: 0.98,  // CHW  Rate Field (Guaranteed Rate)
  146: 0.95,  // MIA  LoanDepot Park
  147: 1.04,  // NYY  Yankee Stadium
  158: 0.98,  // MIL  American Family Field
};

const STATS_API = 'https://statsapi.mlb.com/api';

function makePool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 3,
  });
}

async function fetchTeams(season) {
  const url = `${STATS_API}/v1/teams?sportId=1&season=${season}&activeStatus=Y`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`MLB Stats API ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.teams) ? data.teams : [];
}

(async () => {
  const pool = makePool();
  try {
    console.log(`[seed-equipos-mlb] season=${SEASON} — descargando catálogo MLB Stats API…`);
    const teams = await fetchTeams(SEASON);
    if (!teams.length) {
      console.error('No teams returned by MLB Stats API. Aborting.');
      process.exit(1);
    }
    console.log(`Recibidos ${teams.length} equipos. Upserteando…`);

    let inserted = 0, updated = 0, skipped = 0;
    for (const t of teams) {
      const teamId = Number(t.id);
      if (!Number.isFinite(teamId)) { skipped++; continue; }
      const pf = PARK_FACTORS[teamId] ?? 1.0;
      // league.name = "American League" | "National League" → "AL"/"NL"
      const leagueName = t.league?.name || '';
      const league = /american/i.test(leagueName) ? 'AL' : /national/i.test(leagueName) ? 'NL' : null;
      const division = t.division?.name || null;
      const result = await pool.query(
        `INSERT INTO equipos_mlb (team_id, name, abbreviation, league, division, venue_name, park_factor, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (team_id) DO UPDATE SET
           name         = EXCLUDED.name,
           abbreviation = EXCLUDED.abbreviation,
           league       = EXCLUDED.league,
           division     = EXCLUDED.division,
           venue_name   = EXCLUDED.venue_name,
           park_factor  = EXCLUDED.park_factor,
           updated_at   = NOW()
         RETURNING (xmax = 0) AS is_insert`,
        [teamId, t.name || null, t.abbreviation || null, league, division, t.venue?.name || null, pf]
      );
      if (result.rows[0]?.is_insert) inserted++; else updated++;
    }

    const { rows: counts } = await pool.query(`SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE park_factor <> 1.0) AS with_pf,
      COUNT(*) FILTER (WHERE league = 'AL') AS al,
      COUNT(*) FILTER (WHERE league = 'NL') AS nl
      FROM equipos_mlb`);
    const c = counts[0];

    console.log('');
    console.log(`✓ Seed terminado — insert=${inserted} update=${updated} skip=${skipped}`);
    console.log(`  Tabla: total=${c.total} (AL=${c.al}, NL=${c.nl}) con park_factor≠1.0: ${c.with_pf}/30 esperados`);

    if (Number(c.total) < 30) {
      console.warn(`  ⚠ Esperaba ≥30 equipos en equipos_mlb; hay ${c.total}. Verifica la respuesta de MLB Stats API.`);
    }
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
