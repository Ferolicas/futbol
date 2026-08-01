// Fuente de baloncesto con failover explícito.
//
// 1. NBA CDN/liveData y nba.com/players son la fuente primaria
//    (IDs, logos, fotos, boxscore y jugadas).
// 2. API-NBA (producto NBA específico de API-Sports) es el respaldo de datos.
// 3. API-Basketball solo cubre cuotas y un último fallback de datos.
// Nunca se fusionan dos respuestas incompletas como si fueran hechos distintos:
// cada juego y cada boxscore declara su `dataProvider`/`source`.

import { redisGet, redisSet } from './redis.js';
import {
  getApiSportsGameStatistics,
  getApiSportsGamesByDate,
  getApiSportsPlayerStatistics,
} from './api-sports-multisport.js';

const NBA_SCOREBOARD = 'https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json';
const NBA_SCHEDULE = 'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json';
const NBA_PLAYERS = 'https://www.nba.com/players';
const NBA_BOX = (id) => `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${id}.json`;
const NBA_PBP = (id) => `https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_${id}.json`;
const NBA_CIRCUIT_KEY = 'nba:official:circuit';
const NBA_CIRCUIT_TTL = 6 * 3600;
let nbaCircuitMemory = null;
let nbaPlayersMemory = null;

async function openNbaCircuit(reason) {
  const value = { reason, at: new Date().toISOString() };
  nbaCircuitMemory = { ...value, until: Date.now() + NBA_CIRCUIT_TTL * 1000 };
  await redisSet(NBA_CIRCUIT_KEY, value, NBA_CIRCUIT_TTL);
}

const NBA_TEAMS = [
  [1610612737, 'ATL', 'Atlanta Hawks'], [1610612738, 'BOS', 'Boston Celtics'],
  [1610612751, 'BKN', 'Brooklyn Nets'], [1610612766, 'CHA', 'Charlotte Hornets'],
  [1610612741, 'CHI', 'Chicago Bulls'], [1610612739, 'CLE', 'Cleveland Cavaliers'],
  [1610612742, 'DAL', 'Dallas Mavericks'], [1610612743, 'DEN', 'Denver Nuggets'],
  [1610612765, 'DET', 'Detroit Pistons'], [1610612744, 'GSW', 'Golden State Warriors'],
  [1610612745, 'HOU', 'Houston Rockets'], [1610612754, 'IND', 'Indiana Pacers'],
  [1610612746, 'LAC', 'LA Clippers'], [1610612747, 'LAL', 'Los Angeles Lakers'],
  [1610612763, 'MEM', 'Memphis Grizzlies'], [1610612748, 'MIA', 'Miami Heat'],
  [1610612749, 'MIL', 'Milwaukee Bucks'], [1610612750, 'MIN', 'Minnesota Timberwolves'],
  [1610612740, 'NOP', 'New Orleans Pelicans'], [1610612752, 'NYK', 'New York Knicks'],
  [1610612760, 'OKC', 'Oklahoma City Thunder'], [1610612753, 'ORL', 'Orlando Magic'],
  [1610612755, 'PHI', 'Philadelphia 76ers'], [1610612756, 'PHX', 'Phoenix Suns'],
  [1610612757, 'POR', 'Portland Trail Blazers'], [1610612758, 'SAC', 'Sacramento Kings'],
  [1610612759, 'SAS', 'San Antonio Spurs'], [1610612761, 'TOR', 'Toronto Raptors'],
  [1610612762, 'UTA', 'Utah Jazz'], [1610612764, 'WAS', 'Washington Wizards'],
].map(([id, tricode, name]) => ({ id, tricode, name }));

function cleanName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\b(the|nba|basketball|club)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function cleanPlayerName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\.?$/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const NBA_BY_ID = new Map(NBA_TEAMS.map((team) => [Number(team.id), team]));
const NBA_BY_CODE = new Map(NBA_TEAMS.map((team) => [team.tricode, team]));

export function resolveNbaTeam(value) {
  if (!value) return null;
  const id = Number(value.id || value.teamId);
  if (NBA_BY_ID.has(id)) return NBA_BY_ID.get(id);
  const code = String(value.code || value.tricode || value.teamTricode || '').toUpperCase();
  if (NBA_BY_CODE.has(code)) return NBA_BY_CODE.get(code);
  const wanted = cleanName(value.name || value.fullName || `${value.city || ''} ${value.nickname || ''}`);
  if (!wanted) return null;
  return NBA_TEAMS.find((team) => {
    const candidate = cleanName(team.name);
    return candidate === wanted || candidate.includes(wanted) || wanted.includes(candidate);
  }) || null;
}

export const nbaTeamLogo = (teamId) => teamId
  ? `https://cdn.nba.com/logos/nba/${teamId}/primary/L/logo.svg`
  : null;

export const nbaPlayerPhoto = (personId) => personId
  ? `https://cdn.nba.com/headshots/nba/latest/1040x760/${personId}.png`
  : null;

async function getNbaPlayerIndex() {
  if (nbaPlayersMemory?.until > Date.now()) return nbaPlayersMemory.players;

  const cacheKey = 'nba:official:players:index:v1';
  const cached = await redisGet(cacheKey);
  if (Array.isArray(cached) && cached.length > 0) {
    nbaPlayersMemory = { players: cached, until: Date.now() + 24 * 3600 * 1000 };
    return cached;
  }

  const response = await fetch(NBA_PLAYERS, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (compatible; CFAnalisis/1.0; +https://cfanalisis.com)',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`NBA jugadores HTTP ${response.status}`);

  const html = await response.text();
  const serialized = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!serialized) throw new Error('NBA jugadores sin __NEXT_DATA__');

  const payload = JSON.parse(serialized);
  const players = (payload?.props?.pageProps?.players || []).map((player) => {
    const name = `${player.PLAYER_FIRST_NAME || ''} ${player.PLAYER_LAST_NAME || ''}`.trim();
    return {
      id: String(player.PERSON_ID || ''),
      name,
      normalizedName: cleanPlayerName(name),
      teamId: player.TEAM_ID ? String(player.TEAM_ID) : null,
      teamCode: player.TEAM_ABBREVIATION || null,
      position: player.POSITION || null,
      active: Number(player.ROSTER_STATUS) === 1 && Number(player.IS_DEFUNCT) !== 1,
    };
  }).filter((player) => player.id && player.normalizedName);

  if (players.length === 0) throw new Error('NBA jugadores devolvió un índice vacío');
  nbaPlayersMemory = { players, until: Date.now() + 24 * 3600 * 1000 };
  await redisSet(cacheKey, players, 24 * 3600);
  return players;
}

function matchOfficialNbaPlayer(row, playerIndex) {
  const first = row?.player?.firstname || '';
  const last = row?.player?.lastname || '';
  const name = row?.player?.name || `${first} ${last}`.trim() || row?.name || '';
  const normalizedName = cleanPlayerName(name);
  if (!normalizedName || !Array.isArray(playerIndex)) return null;

  const matches = playerIndex.filter((player) => player.normalizedName === normalizedName);
  if (matches.length <= 1) return matches[0] || null;

  const team = resolveNbaTeam(row?.team || row?.player?.team || {});
  const sameTeam = matches.find((player) => (
    String(player.teamId || '') === String(team?.id || '')
      || String(player.teamCode || '').toUpperCase() === String(team?.tricode || '').toUpperCase()
  ));
  return sameTeam || matches.find((player) => player.active) || matches[0];
}

function normalizeProviderPlayers(rows, playerIndex = []) {
  return (rows || []).map((row) => {
    const first = row.player?.firstname || '';
    const last = row.player?.lastname || '';
    const name = row.player?.name || `${first} ${last}`.trim() || row.name || null;
    const official = matchOfficialNbaPlayer(row, playerIndex);
    const providerPlayerId = row.player?.id || row.id || null;
    return {
      ...row,
      id: String(official?.id || providerPlayerId || ''),
      providerPlayerId: providerPlayerId == null ? null : String(providerPlayerId),
      name: official?.name || name,
      position: official?.position || row.pos || row.position || null,
      photo: official ? nbaPlayerPhoto(official.id) : (row.player?.photo || row.player?.image || null),
      stats: row.stats || row.statistics || row,
    };
  }).filter((player) => player.id);
}

export const nbaStatsInternals = {
  cleanPlayerName,
  matchOfficialNbaPlayer,
  normalizeProviderPlayers,
};

async function nbaFetch(url, cacheKey, ttl) {
  const cached = await redisGet(cacheKey);
  if (cached) return cached;
  if (nbaCircuitMemory?.until <= Date.now()) nbaCircuitMemory = null;
  const circuit = await redisGet(NBA_CIRCUIT_KEY) || nbaCircuitMemory;
  if (circuit) throw new Error(`NBA oficial temporalmente inaccesible: ${circuit.reason || 'circuito abierto'}`);

  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://www.nba.com',
        Referer: 'https://www.nba.com/',
        'User-Agent': 'Mozilla/5.0 (compatible; CFAnalisis/1.0; +https://cfanalisis.com)',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    await openNbaCircuit(error.name === 'TimeoutError' ? 'timeout' : error.message);
    throw error;
  }
  if (!response.ok) {
    if ([401, 403, 429].includes(response.status)) {
      await openNbaCircuit(`HTTP ${response.status}`);
    }
    throw new Error(`NBA oficial HTTP ${response.status}`);
  }
  const data = await response.json();
  await redisSet(cacheKey, data, ttl);
  return data;
}

function isoDay(value) {
  if (!value) return null;
  const direct = String(value).match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (direct) return direct;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function canonicalNbaSeason(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const year = date.getUTCFullYear();
  const start = date.getUTCMonth() >= 6 ? year : year - 1;
  return `${start}-${start + 1}`;
}

function nullableNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function statusShape(code, text) {
  const n = Number(code);
  const normalized = String(text || '').toLowerCase();
  const isFinal = n === 3 || /final|finished|after over time/.test(normalized);
  const isLive = n === 2 || /quarter|half|overtime|live|in play/.test(normalized);
  return { short: isFinal ? 'FT' : (isLive ? 'LIVE' : 'NS'), long: text || (isFinal ? 'Final' : isLive ? 'En vivo' : 'Programado'), isFinal, isLive };
}

function teamShape(raw) {
  const resolved = resolveNbaTeam(raw) || {};
  const id = resolved.id || raw?.teamId || raw?.id || null;
  const tricode = resolved.tricode || raw?.teamTricode || raw?.code || null;
  const name = resolved.name || raw?.teamName || raw?.name || `${raw?.teamCity || ''} ${raw?.teamNickname || ''}`.trim();
  return { id: String(id), name, code: tricode, logo: nbaTeamLogo(id), providerTeamId: raw?.id || raw?.teamId || null };
}

function canonicalGameId(date, home, away) {
  // Un equipo NBA no juega dos veces el mismo día. Omitir la hora mantiene el
  // ID estable ante reprogramaciones y al cambiar NBA oficial ↔ API-NBA.
  return `NBA-${date}-${away.code || away.id}-${home.code || home.id}`;
}

function normalizeOfficialGame(raw, requestedDate) {
  const home = teamShape(raw.homeTeam);
  const away = teamShape(raw.awayTeam);
  const dateUTC = raw.gameTimeUTC || raw.gameDateTimeUTC || raw.gameDateUTC || raw.gameEt || raw.gameDate;
  const date = requestedDate || isoDay(raw.gameDate || dateUTC);
  const status = statusShape(raw.gameStatus, raw.gameStatusText);
  const periods = {
    home: (raw.homeTeam?.periods || []).map((p) => Number(p.score) || 0),
    away: (raw.awayTeam?.periods || []).map((p) => Number(p.score) || 0),
  };
  return {
    id: canonicalGameId(date, home, away),
    providerFixtureId: String(raw.gameId),
    dataProvider: 'nba-official',
    date: dateUTC || `${date}T00:00:00Z`,
    season: canonicalNbaSeason(dateUTC || date),
    league: { id: 'NBA', name: 'NBA', logo: nbaTeamLogo('') },
    country: { name: 'USA' },
    status,
    teams: { home, away },
    scores: { home: { total: nullableNumber(raw.homeTeam?.score) }, away: { total: nullableNumber(raw.awayTeam?.score) } },
    periods,
    raw,
  };
}

function scoreTotal(score) {
  if (score == null) return null;
  if (typeof score === 'number') return score;
  const value = score.total ?? score.points ?? score.current;
  return value == null ? null : Number(value);
}

function periodArray(score = {}) {
  return ['quarter_1', 'quarter_2', 'quarter_3', 'quarter_4', 'over_time']
    .map((key) => score[key] == null ? null : Number(score[key]));
}

export function normalizeApiBasketballGame(raw, requestedDate) {
  const home = teamShape(raw.teams?.home || {});
  const away = teamShape(raw.teams?.away || {});
  const kickoff = raw.date || (raw.timestamp ? new Date(Number(raw.timestamp) * 1000).toISOString() : null);
  const date = requestedDate || isoDay(kickoff);
  const status = statusShape(null, raw.status?.long || raw.status?.short);
  const homeScore = raw.scores?.home || {};
  const awayScore = raw.scores?.away || {};
  return {
    id: canonicalGameId(date, home, away),
    providerFixtureId: String(raw.id),
    dataProvider: 'api-basketball',
    date: kickoff || `${date}T00:00:00Z`,
    season: canonicalNbaSeason(kickoff || date),
    league: { id: 'NBA', name: 'NBA', logo: raw.league?.logo || null, providerLeagueId: raw.league?.id || 12 },
    country: raw.country || { name: 'USA' },
    status,
    teams: { home: { ...home, fallbackLogo: raw.teams?.home?.logo || null }, away: { ...away, fallbackLogo: raw.teams?.away?.logo || null } },
    scores: { home: { total: scoreTotal(homeScore) }, away: { total: scoreTotal(awayScore) } },
    periods: { home: periodArray(homeScore), away: periodArray(awayScore) },
    raw,
  };
}

export function normalizeApiNbaGame(raw, requestedDate) {
  const home = teamShape(raw.teams?.home || {});
  const away = teamShape(raw.teams?.visitors || raw.teams?.away || {});
  const kickoff = raw.date?.start || raw.date || null;
  const date = requestedDate || isoDay(kickoff);
  const status = statusShape(raw.status?.short, raw.status?.long);
  const homeScore = raw.scores?.home || {};
  const awayScore = raw.scores?.visitors || raw.scores?.away || {};
  const toPeriods = (score) => (score?.linescore || []).map(nullableNumber);
  return {
    id: canonicalGameId(date, home, away),
    providerFixtureId: String(raw.id),
    dataProvider: 'api-nba',
    date: kickoff || `${date}T00:00:00Z`,
    season: canonicalNbaSeason(kickoff || date),
    league: { id: 'NBA', name: 'NBA', logo: null, providerLeague: raw.league || 'standard' },
    country: { name: 'USA' },
    status,
    teams: { home, away },
    scores: {
      home: { total: nullableNumber(homeScore.points) },
      away: { total: nullableNumber(awayScore.points) },
    },
    periods: { home: toPeriods(homeScore), away: toPeriods(awayScore) },
    raw,
  };
}

function gamesFromSchedule(payload) {
  const dates = payload?.leagueSchedule?.gameDates || payload?.leagueSchedule?.gameDates || [];
  return dates.flatMap((date) => (date.games || []).map((game) => ({ ...game, gameDate: game.gameDate || date.gameDate })));
}

function gamesFromScoreboard(payload) {
  return payload?.scoreboard?.games || [];
}

async function officialSchedule(date) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  if (date === today) {
    const scoreboard = await nbaFetch(NBA_SCOREBOARD, `nba:scoreboard:${date}`, 60);
    const games = gamesFromScoreboard(scoreboard).map((game) => normalizeOfficialGame(game, date));
    // En off-season un scoreboard vacío es válido; para fechas no-hoy se usa schedule.
    return games;
  }
  const schedule = await nbaFetch(NBA_SCHEDULE, 'nba:schedule:v2', 6 * 3600);
  return gamesFromSchedule(schedule)
    .filter((game) => isoDay(game.gameDate || game.gameDateTimeUTC) === date)
    .map((game) => normalizeOfficialGame(game, date));
}

export async function getBasketballGamesByDate(date, options = {}) {
  if (options.forceFallback !== true) {
    try {
      const official = await officialSchedule(date);
      const nbaToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      if (official.length > 0 || date !== nbaToday) return official;
    } catch (error) {
      console.warn(`[nba] fuente oficial no disponible (${error.message}); fallback API-NBA`);
    }
  }
  if (options.forceGenericFallback !== true) {
    try {
      const data = await getApiSportsGamesByDate('nba', date, { ttl: options.ttl ?? 600 });
      return data.response
        .filter((game) => !game.league || String(game.league).toLowerCase() === 'standard')
        .map((game) => normalizeApiNbaGame(game, date));
    } catch (error) {
      console.warn(`[nba] API-NBA no disponible (${error.message}); último fallback API-Basketball`);
    }
  }
  const generic = await getApiSportsGamesByDate('basketball', date, {
    ttl: options.ttl ?? 600,
    params: { timezone: options.timeZone || 'America/Bogota' },
  });
  const leagueIds = new Set((options.leagueIds || [12]).map(Number));
  return generic.response.filter((game) => leagueIds.has(Number(game.league?.id)))
    .map((game) => normalizeApiBasketballGame(game, date));
}

function officialTeamDetails(team) {
  if (!team) return null;
  const statistics = team.statistics || {};
  const players = (team.players || []).map((player) => ({
    id: String(player.personId || player.person?.id || ''),
    name: player.name || player.person?.displayName || player.person?.fullName || null,
    starter: player.starter === '1' || player.starter === true,
    position: player.position || null,
    photo: nbaPlayerPhoto(player.personId || player.person?.id),
    stats: {
      minutes: player.minutes || null,
      points: Number(player.points) || 0,
      rebounds: Number(player.reboundsTotal ?? player.rebounds) || 0,
      assists: Number(player.assists) || 0,
      steals: Number(player.steals) || 0,
      blocks: Number(player.blocks) || 0,
      turnovers: Number(player.turnovers) || 0,
      threePointersMade: Number(player.threePointersMade) || 0,
    },
  })).filter((player) => player.id);
  return { statistics, players, starters: players.filter((p) => p.starter).map((p) => p.id) };
}

export async function getBasketballGameDetails(game, options = {}) {
  if (!game?.providerFixtureId) return { teams: null, plays: [], source: game?.dataProvider || 'none' };
  if (game.dataProvider === 'nba-official' && options.forceFallback !== true) {
    try {
      const [box, pbp] = await Promise.all([
        nbaFetch(NBA_BOX(game.providerFixtureId), `nba:box:${game.providerFixtureId}`, game.status?.isFinal ? 86400 : 60),
        nbaFetch(NBA_PBP(game.providerFixtureId), `nba:pbp:${game.providerFixtureId}`, game.status?.isFinal ? 86400 : 30).catch(() => null),
      ]);
      return {
        source: 'nba-official',
        teams: {
          home: officialTeamDetails(box?.game?.homeTeam),
          away: officialTeamDetails(box?.game?.awayTeam),
        },
        plays: pbp?.game?.actions || [],
        raw: { boxscore: box, playByPlay: pbp },
      };
    } catch (error) {
      console.warn(`[nba] boxscore oficial ${game.providerFixtureId}: ${error.message}; fallback`);
    }
  }

  const gameDay = isoDay(game.date);
  const sameTeams = (candidate) => (
    String(candidate.teams?.home?.id) === String(game.teams?.home?.id)
      && String(candidate.teams?.away?.id) === String(game.teams?.away?.id)
  ) || (
    cleanName(candidate.teams?.home?.name) === cleanName(game.teams?.home?.name)
      && cleanName(candidate.teams?.away?.name) === cleanName(game.teams?.away?.name)
  );
  const resolveProviderId = async (provider) => {
    if ((provider === 'nba' && game.dataProvider === 'api-nba')
      || (provider === 'basketball' && game.dataProvider === 'api-basketball')) return game.providerFixtureId;
    const canonicalDay = String(game.id || '').match(/^NBA-(\d{4}-\d{2}-\d{2})-/)?.[1];
    for (const date of [...new Set([canonicalDay, gameDay].filter(Boolean))]) {
      const response = await getApiSportsGamesByDate(provider, date, {
        ttl: 1800,
        ...(provider === 'basketball' ? { params: { timezone: options.timeZone || 'America/Bogota' } } : {}),
      });
      const normalized = response.response.map((raw) => provider === 'nba'
        ? normalizeApiNbaGame(raw, date) : normalizeApiBasketballGame(raw, date));
      const found = normalized.find(sameTeams)?.providerFixtureId;
      if (found) return found;
    }
    return null;
  };
  try {
    const nbaId = await resolveProviderId('nba');
    if (nbaId) {
      const [stats, players, playerIndex] = await Promise.all([
        getApiSportsGameStatistics('nba', nbaId, { ttl: game.status?.isFinal ? 86400 : 300 }),
        getApiSportsPlayerStatistics('nba', nbaId, { ttl: game.status?.isFinal ? 86400 : 300 }),
        getNbaPlayerIndex().catch(() => []),
      ]);
      return { source: 'api-nba', teams: stats.response, players: normalizeProviderPlayers(players.response, playerIndex), plays: [], raw: { statistics: stats.response, players: players.response } };
    }
  } catch (error) {
    console.warn(`[nba] detalle API-NBA ${game.id}: ${error.message}; último fallback`);
  }

  const genericId = await resolveProviderId('basketball').catch(() => null);
  if (!genericId) return { source: 'none', teams: null, players: [], plays: [], raw: null };
  const [stats, players, playerIndex] = await Promise.all([
    getApiSportsGameStatistics('basketball', genericId, { ttl: game.status?.isFinal ? 86400 : 300 }).catch(() => ({ response: [] })),
    getApiSportsPlayerStatistics('basketball', genericId, { ttl: game.status?.isFinal ? 86400 : 300 }).catch(() => ({ response: [] })),
    getNbaPlayerIndex().catch(() => []),
  ]);
  return { source: 'api-basketball', teams: stats.response, players: normalizeProviderPlayers(players.response, playerIndex), plays: [], raw: { statistics: stats.response, players: players.response } };
}
