import { getMultisportConfig } from './multisport-config.js';
import {
  getApiSportsGameStatistics,
  getApiSportsGamesByDate,
  getApiSportsOddsForGame,
  getApiSportsPlayerStatistics,
  normalizeApiSportsOdds,
} from './api-sports-multisport.js';
import { getBasketballGameDetails, getBasketballGamesByDate } from './nba-stats-api.js';
import { getMlbGameBoxscore, getMlbLiveGame, getMlbScheduleByDate } from './mlb-stats-api.js';
import {
  espnCompetitionKeysForSport,
  getEspnGameDetails,
  getEspnGamesByDate,
  normalizeEspnOdds,
} from './espn-sports-api.js';

export const mlbTeamLogo = (teamId) => teamId ? `https://www.mlbstatic.com/team-logos/${teamId}.svg` : null;
export const mlbPlayerPhoto = (personId) => personId
  ? `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_360,q_auto:best/v1/people/${personId}/headshot/67/current`
  : null;

function statusFromApi(raw = {}) {
  const short = String(raw.short || '').toUpperCase();
  const long = raw.long || raw.name || short || 'Programado';
  const isFinal = ['FT', 'AOT', 'FINAL'].includes(short) || /final|finished|after over time/i.test(long);
  const isLive = !isFinal && (['LIVE', 'IN', 'HT', 'Q1', 'Q2', 'Q3', 'Q4', 'OT'].includes(short)
    || /quarter|half|overtime|live|in play/i.test(long));
  return { short: isFinal ? 'FT' : (isLive ? 'LIVE' : 'NS'), long, isFinal, isLive, timer: raw.timer || null };
}

function scoreTotal(score) {
  if (score == null) return null;
  if (typeof score === 'number') return score;
  const value = score.total ?? score.points ?? score.current;
  return value == null ? null : Number(value);
}

function periodArray(score = {}) {
  return ['quarter_1', 'quarter_2', 'quarter_3', 'quarter_4']
    .map((key) => score[key] == null ? null : Number(score[key]))
    .concat(score.over_time ?? score.overtime ?? null)
    .map((value) => value == null ? null : Number(value));
}

export function normalizeNflGame(raw, requestedDate) {
  const game = raw.game || raw;
  const kickoff = game.date?.timestamp
    ? new Date(Number(game.date.timestamp) * 1000).toISOString()
    : (game.date?.date && game.date?.time ? `${game.date.date}T${game.date.time}:00Z` : game.date || `${requestedDate}T00:00:00Z`);
  const status = statusFromApi(game.status);
  const homeScore = raw.scores?.home || {};
  const awayScore = raw.scores?.away || {};
  const leagueId = String(raw.league?.id || 1);
  const homeName = raw.teams?.home?.name || 'local';
  const awayName = raw.teams?.away?.name || 'visitante';
  const competitionPrefix = leagueId === '1' ? 'NFL' : 'NCAAF';
  return {
    id: `${competitionPrefix}-${requestedDate}-${fixtureSlug(awayName)}-${fixtureSlug(homeName)}`,
    providerFixtureId: String(game.id),
    dataProvider: 'api-nfl',
    date: kickoff,
    season: String(raw.league?.season || requestedDate.slice(0, 4)),
    league: {
      id: leagueId,
      name: raw.league?.name || 'NFL',
      logo: raw.league?.logo || null,
      providerLeagueId: Number(raw.league?.id || 1),
    },
    country: raw.league?.country || raw.country || { name: 'USA' },
    status,
    teams: {
      home: { id: String(raw.teams?.home?.id || ''), name: raw.teams?.home?.name, code: raw.teams?.home?.code || null, logo: raw.teams?.home?.logo || null },
      away: { id: String(raw.teams?.away?.id || ''), name: raw.teams?.away?.name, code: raw.teams?.away?.code || null, logo: raw.teams?.away?.logo || null },
    },
    scores: { home: { total: scoreTotal(homeScore) }, away: { total: scoreTotal(awayScore) } },
    periods: { home: periodArray(homeScore), away: periodArray(awayScore) },
    raw,
  };
}

export function normalizeMlbGame(raw) {
  const status = { short: raw.isFinal ? 'FT' : (raw.isLive ? 'LIVE' : 'NS'), long: raw.status, isFinal: raw.isFinal, isLive: raw.isLive };
  return {
    id: String(raw.gamePk),
    providerFixtureId: String(raw.gamePk),
    dataProvider: 'mlb-official',
    date: raw.dateUTC,
    season: String(new Date(raw.dateUTC).getUTCFullYear()),
    league: { id: String(raw.sportId || 1), name: raw.sportName || 'MLB', logo: null },
    country: { name: 'Estados Unidos' },
    status,
    teams: {
      home: { id: String(raw.home?.id || ''), name: raw.home?.name, code: raw.home?.abbreviation || null, logo: mlbTeamLogo(raw.home?.id), hits: raw.home?.hits ?? null, errors: raw.home?.errors ?? null, probablePitcherId: raw.home?.probablePitcherId || null, probablePitcherName: raw.home?.probablePitcherName || null },
      away: { id: String(raw.away?.id || ''), name: raw.away?.name, code: raw.away?.abbreviation || null, logo: mlbTeamLogo(raw.away?.id), hits: raw.away?.hits ?? null, errors: raw.away?.errors ?? null, probablePitcherId: raw.away?.probablePitcherId || null, probablePitcherName: raw.away?.probablePitcherName || null },
    },
    scores: { home: { total: raw.home?.score ?? null }, away: { total: raw.away?.score ?? null } },
    periods: {
      home: (raw.innings || []).map((inning) => inning.home ?? null),
      away: (raw.innings || []).map((inning) => inning.away ?? null),
    },
    inning: raw.inning || null,
    inningHalf: raw.inningHalf || null,
    raw,
  };
}

export async function getSportGamesByDate(sport, date, options = {}) {
  const config = getMultisportConfig(sport);
  if (config.key === 'baseball') {
    const requested = new Set((options.competitionKeys || []).map(String));
    const sportIds = (config.competitions || [])
      .filter((competition) => requested.size === 0 || requested.has(competition.key) || requested.has(String(competition.id)))
      .map((competition) => Number(competition.sportId));
    const games = await getMlbScheduleByDate(date, sportIds);
    return uniqueGames(games.map(normalizeMlbGame));
  }
  const requested = new Set((options.competitionKeys || []).map(String));
  const competitionKeys = espnCompetitionKeysForSport(config.key)
    .filter((key) => {
      if (!requested.size) return true;
      const competition = (config.competitions || []).find((item) => item.key === key);
      return requested.has(key) || (competition && requested.has(String(competition.id)));
    });

  if (config.key === 'basketball') {
    const jobs = competitionKeys.map(async (competitionKey) => {
      if (competitionKey !== 'nba') return getEspnGamesByDate(competitionKey, date, options);
      const espnPromise = getEspnGamesByDate('nba', date, options).catch(() => []);
      try {
        const games = await getBasketballGamesByDate(date, options);
        if (games.length) {
          const espnGames = await espnPromise;
          const espnById = new Map(espnGames.map((game) => [String(game.id), game]));
          return games.map((game) => {
            const espnGame = espnById.get(String(game.id)) || espnGames.find((candidate) => teamsMatch(candidate, game));
            return espnGame ? {
              ...game,
              espnOdds: normalizeEspnOdds(espnGame.raw),
              espnProviderFixtureId: espnGame.providerFixtureId,
            } : game;
          });
        }
      } catch (error) {
        console.warn(`[basketball] calendario NBA principal no disponible (${error.message}); respaldo de calendario`);
      }
      return espnPromise;
    });
    return settledGames(jobs, 'Calendario de baloncesto no disponible');
  }

  const jobs = competitionKeys.map(async (competitionKey) => {
    if (competitionKey !== 'nfl' || !withinApiSportsDateWindow(date)) {
      return getEspnGamesByDate(competitionKey, date, options);
    }
    try {
      const response = await getApiSportsGamesByDate('american_football', date, {
        ttl: options.ttl ?? 600,
        params: { timezone: options.timeZone || 'America/Bogota' },
      });
      const games = response.response
        .filter((game) => Number(game.league?.id) === 1)
        .map((game) => normalizeNflGame(game, date));
      if (games.length) return games;
    } catch (error) {
      console.warn(`[american_football] calendario NFL principal no disponible (${error.message}); respaldo de calendario`);
    }
    return getEspnGamesByDate('nfl', date, options);
  });
  return settledGames(jobs, 'Calendario de fútbol americano no disponible');
}

export async function getSportGameDetails(sport, game, options = {}) {
  const config = getMultisportConfig(sport);
  if (String(game?.dataProvider || '').startsWith('espn-')) {
    return getEspnGameDetails(game, options);
  }
  if (config.key === 'baseball') {
    const [live, boxscore] = await Promise.all([
      getMlbLiveGame(game.providerFixtureId).catch(() => null),
      getMlbGameBoxscore(game.providerFixtureId).catch(() => null),
    ]);
    if (!live && !boxscore) return { source: 'mlb-official', teams: null, players: [], plays: [], raw: null };
    const homePeriods = (live?.innings || []).map((inning) => inning.home);
    const awayPeriods = (live?.innings || []).map((inning) => inning.away);
    const boxTeam = (side) => {
      const team = boxscore?.teams?.[side] || {};
      const battingOrder = new Set((team.battingOrder || []).map(Number));
      const firstPitcher = Number(team.pitchers?.[0] || 0);
      const players = Object.values(team.players || {}).map((entry) => {
        const id = Number(entry?.person?.id || 0);
        const hitting = entry?.stats?.batting || entry?.stats?.hitting || {};
        const pitching = entry?.stats?.pitching || {};
        return {
          id: String(id), name: entry?.person?.fullName || null,
          starter: battingOrder.has(id) || id === firstPitcher,
          position: entry?.position?.abbreviation || null,
          photo: mlbPlayerPhoto(id),
          stats: {
            hits: numberOrNull(hitting.hits), homeRuns: numberOrNull(hitting.homeRuns),
            totalBases: numberOrNull(hitting.totalBases), rbis: numberOrNull(hitting.rbi),
            runs: numberOrNull(hitting.runs), doubles: numberOrNull(hitting.doubles),
            triples: numberOrNull(hitting.triples), walks: numberOrNull(hitting.baseOnBalls),
            battingStrikeouts: numberOrNull(hitting.strikeOuts), stolenBases: numberOrNull(hitting.stolenBases),
            strikeouts: numberOrNull(pitching.strikeOuts), inningsPitched: pitching.inningsPitched || null,
            walksAllowed: numberOrNull(pitching.baseOnBalls), hitsAllowed: numberOrNull(pitching.hits),
            earnedRuns: numberOrNull(pitching.earnedRuns), pitchesThrown: numberOrNull(pitching.pitchesThrown),
          },
        };
      }).filter((player) => player.id !== '0');
      return {
        statistics: {
          hits: live?.[side]?.hits ?? team?.teamStats?.batting?.hits,
          errors: live?.[side]?.errors ?? team?.teamStats?.fielding?.errors,
        },
        starterId: firstPitcher || null,
        starters: players.filter((p) => p.starter).map((p) => p.id),
        players,
      };
    };
    const home = boxTeam('home');
    const away = boxTeam('away');
    return {
      source: 'mlb-official',
      teams: { home, away },
      periods: { home: homePeriods, away: awayPeriods },
      players: [...home.players, ...away.players],
      plays: live?.recentPlays || [],
      raw: live,
    };
  }
  if (config.key === 'basketball') return getBasketballGameDetails(game, options);
  const [statistics, players] = await Promise.all([
    getApiSportsGameStatistics('american_football', game.providerFixtureId, { ttl: game.status?.isFinal ? 86400 : 300 }).catch(() => ({ response: [] })),
    getApiSportsPlayerStatistics('american_football', game.providerFixtureId, { ttl: game.status?.isFinal ? 86400 : 300 }).catch(() => ({ response: [] })),
  ]);
  const normalizedPlayerTeams = normalizeNflPlayerGroups(players.response);
  const teams = statistics.response.map((team) => ({
    ...team,
    players: normalizedPlayerTeams.find((entry) => String(entry.team?.id || '') === String(team.team?.id || '')
      || normalizedName(entry.team?.name) === normalizedName(team.team?.name))?.players || [],
  }));
  return { source: 'api-nfl', teams, players: normalizedPlayerTeams, plays: [], raw: { statistics: statistics.response, players: players.response } };
}

function statFromList(statistics, names) {
  const wanted = new Set(names.map((name) => normalizedName(name)));
  const hit = (statistics || []).find((entry) => wanted.has(normalizedName(entry?.name)));
  return numberOrNull(hit?.value);
}

function normalizeNflPlayerGroups(teamRows = []) {
  return teamRows.map((teamRow) => {
    const players = new Map();
    for (const group of teamRow.groups || []) {
      const groupName = normalizedName(group.name);
      for (const entry of group.players || []) {
        const id = String(entry.player?.id || '');
        if (!id) continue;
        const current = players.get(id) || {
          id, name: entry.player?.name || null, photo: entry.player?.image || null,
          team: teamRow.team, stats: {}, starter: null, position: group.name || null,
        };
        if (groupName === 'passing') {
          current.stats.passingYards = statFromList(entry.statistics, ['yards']);
          current.stats.passingTouchdowns = statFromList(entry.statistics, ['passing touch downs', 'passing touchdowns']);
          current.stats.interceptionsThrown = statFromList(entry.statistics, ['interceptions']);
          current.stats.passingSacksTaken = statFromList(entry.statistics, ['sacks']);
        } else if (groupName === 'rushing') {
          current._hasScrimmageTouchdowns = true;
          current.stats.rushingAttempts = statFromList(entry.statistics, ['total rushes']);
          current.stats.rushingYards = statFromList(entry.statistics, ['yards']);
          current.stats.rushingTouchdowns = statFromList(entry.statistics, ['rushing touch downs', 'rushing touchdowns']);
        } else if (groupName === 'receiving') {
          current._hasScrimmageTouchdowns = true;
          current.stats.targets = statFromList(entry.statistics, ['targets']);
          current.stats.receivingYards = statFromList(entry.statistics, ['yards']);
          current.stats.receptions = statFromList(entry.statistics, ['total receptions', 'receptions']);
          current.stats.receivingTouchdowns = statFromList(entry.statistics, ['receiving touch downs', 'receiving touchdowns']);
        } else if (groupName === 'fumbles') {
          current.stats.fumbles = statFromList(entry.statistics, ['total']);
          current.stats.fumblesLost = statFromList(entry.statistics, ['lost']);
        } else if (groupName === 'defensive') {
          current.stats.tackles = statFromList(entry.statistics, ['tackles']);
          current.stats.sacks = statFromList(entry.statistics, ['sacks']);
        }
        const rushing = numberOrNull(current.stats.rushingTouchdowns) || 0;
        const receiving = numberOrNull(current.stats.receivingTouchdowns) || 0;
        if (current._hasScrimmageTouchdowns) current.stats.touchdowns = rushing + receiving;
        players.set(id, current);
      }
    }
    return {
      team: teamRow.team,
      players: [...players.values()].map(({ _hasScrimmageTouchdowns, ...player }) => player),
    };
  });
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\b(fc|cf|club|baseball|basketball|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function fixtureSlug(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function uniqueGames(games) {
  return [...new Map(games.map((game) => [String(game.id), game])).values()]
    .sort((left, right) => new Date(left.date) - new Date(right.date));
}

async function settledGames(jobs, fallbackMessage) {
  const attempts = await Promise.allSettled(jobs);
  const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
  if (!fulfilled.length) throw attempts.find((attempt) => attempt.status === 'rejected')?.reason || new Error(fallbackMessage);
  return uniqueGames(fulfilled.flatMap((attempt) => attempt.value));
}

function withinApiSportsDateWindow(date, now = new Date()) {
  const requested = new Date(`${date}T12:00:00Z`).getTime();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12);
  if (!Number.isFinite(requested)) return false;
  const days = Math.round((requested - today) / 86_400_000);
  return days >= -2 && days <= 0;
}

function teamsMatch(source, target) {
  const aHome = normalizedName(source?.teams?.home?.name);
  const aAway = normalizedName(source?.teams?.away?.name);
  const bHome = normalizedName(target?.teams?.home?.name);
  const bAway = normalizedName(target?.teams?.away?.name);
  return !!aHome && !!aAway && (aHome.includes(bHome) || bHome.includes(aHome)) && (aAway.includes(bAway) || bAway.includes(aAway));
}

async function apiSportsFixtureIdFor(sport, game) {
  if ((sport === 'american_football' && game.dataProvider === 'api-nfl')
    || (sport === 'basketball' && game.dataProvider === 'api-basketball')) {
    return game.providerFixtureId;
  }
  const date = new Date(game.date).toISOString().slice(0, 10);
  const provider = sport === 'baseball' ? 'baseball'
    : sport === 'american_football' ? 'american_football' : 'basketball';
  if (!withinApiSportsDateWindow(date)) return null;
  const response = await getApiSportsGamesByDate(provider, date, { ttl: 6 * 3600 });
  const hit = response.response.find((candidate) => teamsMatch(candidate, game));
  return hit?.id ? String(hit.id) : null;
}

export const multisportProviderInternals = {
  fixtureSlug,
  uniqueGames,
  withinApiSportsDateWindow,
};

export async function getSportOdds(sport, game, options = {}) {
  const config = getMultisportConfig(sport);
  const provider = config.oddsProvider;
  // Defensa para payloads/colas antiguas: MiLB está fuera de la configuración
  // activa y nunca debe provocar una consulta de cuotas sin catálogo Bet365.
  if (config.key === 'baseball' && String(game?.league?.id || '1') !== '1') {
    return {
      moneyline: {}, totals: {}, spreads: {}, periods: {}, teamTotals: { home: {}, away: {} },
      statistics: { hits: { home: {}, away: {}, total: {} } }, playerProps: {},
      specials: {},
      catalog: [], rawBookmakers: [], source: 'sin-cuota-publicada', providerFixtureId: null,
    };
  }
  const date = new Date(game.date).toISOString().slice(0, 10);
  const embedded = game.espnOdds || (String(game?.dataProvider || '').startsWith('espn-')
    ? normalizeEspnOdds(game.raw)
    : null);
  const hasEmbeddedOdds = embedded && (
    Object.keys(embedded.moneyline || {}).length > 0
    || Object.keys(embedded.totals || {}).length > 0
  );
  // Las jornadas universitarias pueden superar ampliamente los 100 partidos.
  // Sus cuotas incluidas en el calendario evitan una llamada por encuentro y,
  // si aún no se publicaron, se conserva la probabilidad sin inventar cuota.
  if (/^espn-ncaa/.test(String(game?.dataProvider || ''))) {
    return { ...embedded, source: 'espn-odds', providerFixtureId: game.providerFixtureId };
  }
  // Los planes gratuitos de API-Sports no publican jornadas futuras. Cuando
  // el calendario oficial ya trae cuotas reales, se usan sin una llamada por
  // partido; el porcentaje empírico permanece completamente separado.
  if (hasEmbeddedOdds && !withinApiSportsDateWindow(date)) {
    return { ...embedded, source: 'espn-odds', providerFixtureId: game.espnProviderFixtureId || game.providerFixtureId };
  }
  const providerFixtureId = await apiSportsFixtureIdFor(config.key, game);
  if (!providerFixtureId) return {
    moneyline: {}, totals: {}, spreads: {}, periods: {}, teamTotals: { home: {}, away: {} },
    statistics: { hits: { home: {}, away: {}, total: {} } }, playerProps: {},
    specials: {},
    catalog: [], rawBookmakers: [], source: `api-${provider}`, providerFixtureId: null,
  };
  const payload = await getApiSportsOddsForGame(provider, providerFixtureId, { ttl: options.ttl ?? 6 * 3600 });
  return {
    ...normalizeApiSportsOdds(payload, game, {
      sport: config.key,
      // Baseball se vende contra el catálogo de una única casa. No se toma
      // una cuota mejor de otra casa porque podría corresponder a una línea
      // que el cliente no encontrará en Bet365.
      ...(config.key === 'baseball' ? { bookmakers: ['Bet365'] } : {}),
    }),
    source: `api-${provider}`,
    providerFixtureId,
  };
}
