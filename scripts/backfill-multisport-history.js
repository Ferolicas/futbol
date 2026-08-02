/* eslint-disable */
// Backfill de resultados observados para los motores independientes.
//
// Uso:
//   node scripts/backfill-multisport-history.js baseball 2025
//   node scripts/backfill-multisport-history.js basketball 2025 --competition=nba,ncaa
//   node scripts/backfill-multisport-history.js american_football 2025 --competition=nfl,ncaa-fbs,ncaa-fcs
//   añadir --dry para auditar cobertura sin escribir PostgreSQL.

import { getEspnGamesByDate } from '../lib/espn-sports-api.js';
import { getSportCompetitions } from '../lib/multisport-config.js';
import { normalizeMlbGame } from '../lib/multisport-providers.js';
import { getMlbScheduleByRange } from '../lib/mlb-stats-api.js';
import {
  ingestFinalSportGames,
  persistSportGames,
} from '../lib/multisport-store.js';

let databasePool = null;

async function getDatabasePool() {
  if (!databasePool) databasePool = (await import('../lib/db.js')).pgPool;
  return databasePool;
}

function cliValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || null;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function dateRange(start, end) {
  const dates = [];
  const cursor = new Date(`${start}T12:00:00Z`);
  const limit = new Date(`${end}T12:00:00Z`);
  while (cursor <= limit) {
    dates.push(isoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function competitionDateRange(sport, competition, season) {
  const next = Number(season) + 1;
  if (sport === 'basketball') {
    return competition === 'ncaa'
      ? [`${season}-11-01`, `${next}-04-15`]
      : [`${season}-09-20`, `${next}-06-30`];
  }
  if (competition === 'nfl') return [`${season}-08-01`, `${next}-02-20`];
  return [`${season}-08-01`, `${next}-01-31`];
}

function selectedCompetitions(sport, requested) {
  const available = getSportCompetitions(sport);
  const values = String(requested || 'all').split(',').map((value) => value.trim()).filter(Boolean);
  if (values.includes('all')) return available;
  if (sport === 'baseball' && values.includes('minor')) {
    throw new Error('MiLB está desactivado: el producto solo consulta MLB porque exige mercados Bet365 apostables');
  }
  const wanted = new Set(values);
  const selected = available.filter((competition) => wanted.has(competition.key) || wanted.has(String(competition.id)));
  if (!selected.length) throw new Error(`Competición inválida para ${sport}: ${requested}`);
  return selected;
}

async function mapLimited(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(runners);
  return output;
}

async function withRetry(label, task, attempts = 4) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delay = 400 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 150);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`${label}: ${lastError?.message || 'fallo desconocido'}`, { cause: lastError });
}

function uniqueGames(games) {
  return [...new Map(games.map((game) => [String(game.id), game])).values()]
    .sort((left, right) => new Date(left.date) - new Date(right.date));
}

async function fetchBaseballSeason(season, competitions) {
  const chunks = [];
  let cursor = new Date(`${season}-01-01T12:00:00Z`);
  const seasonEnd = new Date(`${season}-12-31T12:00:00Z`);
  const today = new Date();
  const effectiveEnd = seasonEnd > today ? today : seasonEnd;
  while (cursor <= effectiveEnd) {
    const start = isoDate(cursor);
    const endDate = new Date(cursor);
    endDate.setUTCDate(endDate.getUTCDate() + 44);
    if (endDate > effectiveEnd) endDate.setTime(effectiveEnd.getTime());
    chunks.push([start, isoDate(endDate)]);
    cursor = new Date(endDate);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const sportIds = competitions.map((competition) => Number(competition.sportId));
  const schedules = [];
  for (const [start, end] of chunks) {
    schedules.push(...await withRetry(
      `MLB Stats ${start}..${end}`,
      () => getMlbScheduleByRange(start, end, sportIds),
    ));
  }
  return {
    requests: chunks.length,
    games: schedules.map(normalizeMlbGame),
  };
}

async function fetchEspnSeason(sport, season, competitions) {
  const tasks = competitions.flatMap((competition) => {
    const [start, end] = competitionDateRange(sport, competition.key, season);
    const today = new Date().toISOString().slice(0, 10);
    const effectiveEnd = end > today ? today : end;
    if (start > effectiveEnd) return [];
    return dateRange(start, effectiveEnd).map((date) => ({ competition: competition.key, date }));
  });
  const lists = await mapLimited(tasks, 6, async (task, index) => {
    const games = await withRetry(
      `calendario ${task.competition} ${task.date}`,
      () => getEspnGamesByDate(task.competition, task.date, { ttl: 30 * 86400 }),
    );
    if ((index + 1) % 50 === 0) console.log(`[backfill] ${index + 1}/${tasks.length} jornadas consultadas`);
    return games;
  });
  return { requests: tasks.length, games: uniqueGames(lists.flat()) };
}

async function main() {
  const sport = process.argv[2];
  const season = process.argv[3];
  const dry = process.argv.includes('--dry');
  if (!['baseball', 'basketball', 'american_football'].includes(sport) || !/^\d{4}$/.test(String(season || ''))) {
    throw new Error('Uso: node scripts/backfill-multisport-history.js <baseball|basketball|american_football> <temporada> [--competition=...] [--dry]');
  }
  const competitions = selectedCompetitions(sport, cliValue('competition'));
  const fetched = sport === 'baseball'
    ? await fetchBaseballSeason(season, competitions)
    : await fetchEspnSeason(sport, season, competitions);
  const games = uniqueGames(fetched.games);
  const finals = games.filter((game) => game.status?.isFinal
    && game.scores?.home?.total != null
    && game.scores?.away?.total != null);
  const byCompetition = Object.fromEntries(competitions.map((competition) => [
    competition.name,
    {
      fetched: games.filter((game) => String(game.league?.id) === String(competition.id)).length,
      finals: finals.filter((game) => String(game.league?.id) === String(competition.id)).length,
    },
  ]));
  const summary = {
    ok: true,
    dry,
    sport,
    provider: sport === 'baseball' ? 'MLB Stats' : 'calendario deportivo',
    season,
    competitions: competitions.map((competition) => competition.name),
    requests: fetched.requests,
    fetched: games.length,
    finals: finals.length,
    byCompetition,
  };
  if (dry) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const pool = await getDatabasePool();
  await persistSportGames(pool, sport, games);
  const ingestion = await ingestFinalSportGames(pool, sport, finals, { skipPersist: true });
  console.log(JSON.stringify({ ...summary, ingested: ingestion.ingested }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (databasePool) await databasePool.end();
  const { closeRedisClient } = await import('../lib/redis.js');
  await closeRedisClient();
});
