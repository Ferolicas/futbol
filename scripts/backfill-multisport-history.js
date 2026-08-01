/* eslint-disable */
// Backfill controlado de resultados históricos: MLB Stats oficial para MLB y
// endpoints de temporada de API-NBA/API-NFL para los otros deportes.
// Uso (una temporada por ejecución para proteger la cuota free):
//   node scripts/backfill-multisport-history.js baseball 2025
//   node scripts/backfill-multisport-history.js basketball 2024
//   node scripts/backfill-multisport-history.js american_football 2024

import { apiSportsRequest } from '../lib/api-sports-multisport.js';
import { normalizeApiNbaGame } from '../lib/nba-stats-api.js';
import { normalizeMlbGame, normalizeNflGame } from '../lib/multisport-providers.js';
import { getMlbScheduleByRange } from '../lib/mlb-stats-api.js';
import { ingestFinalSportGame, persistSportGames } from '../lib/multisport-store.js';

let databasePool = null;

async function getDatabasePool() {
  if (!databasePool) databasePool = (await import('../lib/db.js')).pgPool;
  return databasePool;
}

async function main() {
  const sport = process.argv[2];
  const season = process.argv[3];
  const dry = process.argv.includes('--dry');
  if (!['baseball', 'basketball', 'american_football'].includes(sport) || !/^\d{4}$/.test(String(season || ''))) {
    throw new Error('Uso: node scripts/backfill-multisport-history.js <baseball|basketball|american_football> <season>');
  }
  if (sport === 'baseball') {
    const chunks = [];
    let cursor = new Date(`${season}-01-01T12:00:00Z`);
    const seasonEnd = new Date(`${season}-12-31T12:00:00Z`);
    while (cursor <= seasonEnd) {
      const start = cursor.toISOString().slice(0, 10);
      const endDate = new Date(cursor);
      endDate.setUTCDate(endDate.getUTCDate() + 44);
      if (endDate > seasonEnd) endDate.setTime(seasonEnd.getTime());
      chunks.push([start, endDate.toISOString().slice(0, 10)]);
      cursor = new Date(endDate);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const schedules = [];
    for (const [start, end] of chunks) schedules.push(...await getMlbScheduleByRange(start, end, 1));
    const games = schedules.map(normalizeMlbGame)
      .filter((game) => game.status.isFinal && game.scores.home.total != null && game.scores.away.total != null);
    if (dry) {
      console.log(JSON.stringify({ ok: true, dry: true, sport, provider: 'mlb-official', season, requests: chunks.length, fetched: schedules.length, finals: games.length }, null, 2));
      return;
    }
    const pgPool = await getDatabasePool();
    await persistSportGames(pgPool, sport, games);
    let ingested = 0;
    for (const game of games) {
      const result = await ingestFinalSportGame(pgPool, sport, game, null, { skipPersist: true });
      if (result.ingested) ingested++;
    }
    console.log(JSON.stringify({ ok: true, sport, provider: 'mlb-official', season, requests: chunks.length, fetched: schedules.length, finals: games.length, ingested }, null, 2));
    return;
  }
  const provider = sport === 'basketball' ? 'nba' : 'american_football';
  const league = Number(process.env.API_NFL_LEAGUE_ID || 1);
  // Ambos productos devuelven la temporada completa en una sola respuesta.
  // No se manda `page`: no forma parte de estos contratos y sería rechazado.
  const params = sport === 'basketball' ? { season } : { league, season };
  const result = await apiSportsRequest(provider, '/games', params, {
    ttl: 86400, cacheKey: `apisports:${provider}:history:${season}`,
  });
  const rawGames = result.response;
  const nbaDay = (value) => {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(value)); }
    catch { return String(value || '').slice(0, 10); }
  };
  const games = rawGames
    .filter((raw) => sport !== 'basketball' || !raw.league || String(raw.league).toLowerCase() === 'standard')
    .map((raw) => sport === 'basketball'
      ? normalizeApiNbaGame(raw, nbaDay(raw.date?.start))
      : normalizeNflGame(raw, String(raw.game?.date?.date || '').slice(0, 10)))
    .filter((game) => game.status.isFinal && game.scores.home.total != null && game.scores.away.total != null);
  if (dry) {
    console.log(JSON.stringify({ ok: true, dry: true, sport, provider, season, requests: 1, fetched: rawGames.length, finals: games.length }, null, 2));
    return;
  }
  const pgPool = await getDatabasePool();
  await persistSportGames(pgPool, sport, games);
  let ingested = 0;
  for (const game of games) {
    const result = await ingestFinalSportGame(pgPool, sport, game, null, { skipPersist: true });
    if (result.ingested) ingested++;
  }
  console.log(JSON.stringify({ ok: true, sport, provider, season, requests: 1, fetched: rawGames.length, finals: games.length, ingested }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (databasePool) await databasePool.end();
  const { closeRedisClient } = await import('../lib/redis.js');
  await closeRedisClient();
});
