/* eslint-disable */
// Backfill del boxscore de jugadores de la NBA (puntos, rebotes, asistencias,
// triples y su desglose por cuarto) y de las estadísticas de equipo que el
// backfill de calendario no trae.
//
// Uso:
//   node scripts/backfill-nba-player-details.js 2025            # temporada 2025-26 completa
//   node scripts/backfill-nba-player-details.js 2026 --from=2026-10-20
//   añadir --dry para contar sin escribir, --force para rehacer lo ya cargado.
//
// Solo completa partidos que YA existen en basketball_engine_matches con el
// mismo ID: nunca crea un partido nuevo, así que no puede duplicar la muestra
// del motor. La pretemporada se omite.

import { getEspnGameDetails, getEspnGamesByDate } from '../lib/espn-sports-api.js';
import { ingestFinalSportGame } from '../lib/multisport-store.js';

let databasePool = null;
async function getDatabasePool() {
  if (!databasePool) databasePool = (await import('../lib/db.js')).pgPool;
  return databasePool;
}

function cliValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || null;
}

function dateRange(start, end) {
  const dates = [];
  const cursor = new Date(`${start}T12:00:00Z`);
  const limit = new Date(`${end}T12:00:00Z`);
  while (cursor <= limit) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

async function withRetry(label, task, attempts = 4) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await task(); } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** (attempt - 1))));
    }
  }
  throw new Error(`${label}: ${lastError?.message || 'fallo desconocido'}`, { cause: lastError });
}

async function mapLimited(items, concurrency, mapper) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) await mapper(items[cursor++]);
  }));
}

async function main() {
  const season = process.argv[2];
  if (!/^\d{4}$/.test(String(season || ''))) {
    throw new Error('Uso: node scripts/backfill-nba-player-details.js <año de inicio> [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--concurrency=4] [--dry] [--force]');
  }
  const dry = process.argv.includes('--dry');
  const force = process.argv.includes('--force');
  const today = new Date().toISOString().slice(0, 10);
  const from = cliValue('from') || `${season}-10-01`;
  const requestedTo = cliValue('to') || `${Number(season) + 1}-06-30`;
  const to = requestedTo > today ? today : requestedTo;
  const concurrency = Math.max(1, Math.min(8, Number(cliValue('concurrency')) || 4));
  const pool = await getDatabasePool();
  const summary = { season, from, to, dry, days: 0, finals: 0, preseason: 0, alreadyComplete: 0, unmatched: 0, ingested: 0, withQuarterStats: 0, failed: 0, errors: [] };

  for (const date of dateRange(from, to)) {
    summary.days += 1;
    const games = await withRetry(`calendario ${date}`, () => getEspnGamesByDate('nba', date, { ttl: 3600 }));
    const finals = games.filter((game) => game.status?.isFinal
      && game.scores?.home?.total != null && game.scores?.away?.total != null);
    const official = finals.filter((game) => Number(game.raw?.season?.type) !== 1);
    summary.preseason += finals.length - official.length;
    summary.finals += official.length;
    if (!official.length) continue;

    const ids = official.map((game) => String(game.id));
    const [known, complete] = await Promise.all([
      pool.query('SELECT fixture_id FROM basketball_engine_matches WHERE fixture_id=ANY($1::text[])', [ids]),
      pool.query(
        `SELECT fixture_id FROM basketball_engine_player_stats
         WHERE fixture_id=ANY($1::text[]) AND stats ? 'rebounds' GROUP BY fixture_id HAVING count(*) >= 10`,
        [ids],
      ),
    ]);
    const knownIds = new Set(known.rows.map((row) => String(row.fixture_id)));
    const completeIds = new Set(complete.rows.map((row) => String(row.fixture_id)));
    const pending = [];
    for (const game of official) {
      if (!knownIds.has(String(game.id))) { summary.unmatched += 1; continue; }
      if (!force && completeIds.has(String(game.id))) { summary.alreadyComplete += 1; continue; }
      pending.push(game);
    }
    if (dry) { summary.ingested += pending.length; continue; }

    await mapLimited(pending, concurrency, async (game) => {
      try {
        // TTL corto: el resumen de un partido pesa cientos de KB y un backfill
        // de varias temporadas no debe quedarse a vivir en Redis.
        const details = await withRetry(`boxscore ${game.id}`, () => getEspnGameDetails(game, { ttl: 60 }));
        if (!details?.players?.some((team) => team.players?.length)) throw new Error('boxscore sin jugadores');
        // El resumen crudo no se persiste: el partido ya existe (skipPersist).
        await ingestFinalSportGame(pool, 'basketball', game, { ...details, raw: null }, { skipPersist: true });
        summary.ingested += 1;
        if (details.players.some((team) => team.players.some((player) => player.stats?.q1Points != null))) summary.withQuarterStats += 1;
      } catch (error) {
        summary.failed += 1;
        if (summary.errors.length < 10) summary.errors.push(`${game.id}: ${error.message}`);
      }
    });
    if (summary.days % 20 === 0) console.log(`[backfill-nba] ${date} · ${summary.ingested} cargados · ${summary.failed} fallidos · ${summary.unmatched} sin partido`);
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (databasePool) await databasePool.end();
  const { closeRedisClient } = await import('../lib/redis.js');
  await closeRedisClient();
});
