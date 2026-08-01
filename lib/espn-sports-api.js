// Calendarios amplios y boxscores públicos de ESPN.
//
// API-Sports sigue siendo la fuente de cuotas y, cuando su ventana gratuita lo
// permite, de datos en vivo. ESPN evita que el calendario quede vacío al mirar
// jornadas históricas o futuras y aporta NCAA sin mezclar sus IDs con NBA/NFL.

import { redisGet, redisSet } from './redis.js';
import { nbaTeamLogo, resolveNbaTeam } from './nba-stats-api.js';

const API = 'https://site.api.espn.com/apis/site/v2/sports';

const COMPETITIONS = Object.freeze({
  nba: {
    key: 'nba', sport: 'basketball', league: 'nba', id: 'NBA', name: 'NBA',
    providerLeagueId: 12, teamPrefix: 'NBA', fixturePrefix: 'NBA',
  },
  ncaa: {
    key: 'ncaa', sport: 'basketball', league: 'mens-college-basketball', id: '116', name: 'NCAA',
    providerLeagueId: 116, group: 50, teamPrefix: 'NCAAB', fixturePrefix: 'NCAAB',
  },
  nfl: {
    key: 'nfl', sport: 'football', league: 'nfl', id: '1', name: 'NFL',
    providerLeagueId: 1, teamPrefix: 'NFL', fixturePrefix: 'NFL',
  },
  'ncaa-fbs': {
    key: 'ncaa-fbs', sport: 'football', league: 'college-football', id: 'NCAA-FBS', name: 'NCAA FBS',
    providerLeagueId: 2, group: 80, teamPrefix: 'NCAAF', fixturePrefix: 'NCAAF',
  },
  'ncaa-fcs': {
    key: 'ncaa-fcs', sport: 'football', league: 'college-football', id: 'NCAA-FCS', name: 'NCAA FCS',
    providerLeagueId: 2, group: 81, teamPrefix: 'NCAAF', fixturePrefix: 'NCAAF',
  },
});

const NFL_TEAMS = [
  [11, 'ARI', 'Arizona Cardinals'], [8, 'ATL', 'Atlanta Falcons'], [5, 'BAL', 'Baltimore Ravens'],
  [20, 'BUF', 'Buffalo Bills'], [19, 'CAR', 'Carolina Panthers'], [16, 'CHI', 'Chicago Bears'],
  [10, 'CIN', 'Cincinnati Bengals'], [9, 'CLE', 'Cleveland Browns'], [29, 'DAL', 'Dallas Cowboys'],
  [28, 'DEN', 'Denver Broncos'], [7, 'DET', 'Detroit Lions'], [15, 'GB', 'Green Bay Packers'],
  [26, 'HOU', 'Houston Texans'], [21, 'IND', 'Indianapolis Colts'], [2, 'JAX', 'Jacksonville Jaguars'],
  [17, 'KC', 'Kansas City Chiefs'], [1, 'LV', 'Las Vegas Raiders'], [30, 'LAC', 'Los Angeles Chargers'],
  [31, 'LAR', 'Los Angeles Rams'], [25, 'MIA', 'Miami Dolphins'], [32, 'MIN', 'Minnesota Vikings'],
  [3, 'NE', 'New England Patriots'], [27, 'NO', 'New Orleans Saints'], [4, 'NYG', 'New York Giants'],
  [13, 'NYJ', 'New York Jets'], [12, 'PHI', 'Philadelphia Eagles'], [22, 'PIT', 'Pittsburgh Steelers'],
  [14, 'SF', 'San Francisco 49ers'], [23, 'SEA', 'Seattle Seahawks'], [24, 'TB', 'Tampa Bay Buccaneers'],
  [6, 'TEN', 'Tennessee Titans'], [18, 'WSH', 'Washington Commanders'],
].map(([id, code, name]) => ({ id: String(id), code, name }));

function normalizedName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function slug(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function seasonFor(config, date, rawSeason) {
  const parsed = new Date(date);
  if (config.sport === 'basketball' && Number.isFinite(parsed.getTime())) {
    const year = parsed.getUTCFullYear();
    const start = parsed.getUTCMonth() >= 6 ? year : year - 1;
    return `${start}-${start + 1}`;
  }
  return String(rawSeason?.year || (Number.isFinite(parsed.getTime()) ? parsed.getUTCFullYear() : ''));
}

function statusShape(raw = {}) {
  const type = raw.type || {};
  const state = String(type.state || '').toLowerCase();
  const isFinal = type.completed === true || state === 'post';
  const isLive = !isFinal && state === 'in';
  return {
    short: isFinal ? 'FT' : (isLive ? 'LIVE' : 'NS'),
    long: isFinal ? 'Finalizado' : (isLive ? 'En vivo' : 'Programado'),
    isFinal,
    isLive,
    timer: type.shortDetail || type.detail || raw.displayClock || null,
    period: Number(raw.period || 0) || null,
  };
}

function nflTeam(team = {}) {
  const code = String(team.abbreviation || '').toUpperCase();
  const name = team.displayName || team.shortDisplayName || team.name || '';
  return NFL_TEAMS.find((candidate) => candidate.code === code)
    || NFL_TEAMS.find((candidate) => normalizedName(candidate.name) === normalizedName(name))
    || null;
}

function teamShape(competitor = {}, config) {
  const raw = competitor.team || competitor;
  const name = raw.displayName || raw.shortDisplayName || raw.name || competitor.displayName || 'Equipo';
  const code = raw.abbreviation || null;
  if (config.key === 'nba') {
    const canonical = resolveNbaTeam({ id: raw.id, name, code });
    if (canonical) return {
      id: String(canonical.id), name: canonical.name, code: canonical.tricode,
      logo: nbaTeamLogo(canonical.id), providerTeamId: String(raw.id || ''),
    };
  }
  if (config.key === 'nfl') {
    const canonical = nflTeam(raw);
    if (canonical) return {
      id: canonical.id, name: canonical.name, code: canonical.code,
      logo: raw.logo || competitor.logo || null, providerTeamId: String(raw.id || ''),
    };
  }
  return {
    id: `${config.teamPrefix}:${raw.id || slug(name)}`,
    name,
    code,
    logo: raw.logo || competitor.logo || null,
    providerTeamId: String(raw.id || ''),
  };
}

function scoreValue(competitor, status) {
  if (!status.isLive && !status.isFinal) return null;
  const value = Number(competitor?.score);
  return Number.isFinite(value) ? value : null;
}

function periodScores(competitor = {}) {
  return (competitor.linescores || []).map((period) => {
    const value = Number(period?.value ?? period?.displayValue);
    return Number.isFinite(value) ? value : null;
  });
}

function canonicalFixtureId(config, requestedDate, raw, home, away) {
  if (config.key === 'nba') {
    return `NBA-${requestedDate}-${away.code || away.id}-${home.code || home.id}`;
  }
  if (config.key === 'nfl') {
    return `NFL-${requestedDate}-${slug(away.name)}-${slug(home.name)}`;
  }
  return `${config.fixturePrefix}:${raw.id}`;
}

function americanToDecimal(value) {
  const american = Number(String(value ?? '').replace('+', ''));
  if (!Number.isFinite(american) || american === 0) return null;
  const decimal = american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
  return Math.round(decimal * 1000) / 1000;
}

function closingOdd(side) {
  return americanToDecimal(side?.close?.odds ?? side?.open?.odds);
}

export function normalizeEspnOdds(rawGame) {
  const row = rawGame?.competitions?.[0]?.odds?.[0];
  if (!row) return { moneyline: {}, totals: {}, spreads: {}, periods: {}, rawBookmakers: [] };
  const bookmaker = row.provider?.displayName || row.provider?.name || 'Casa de apuestas';
  const result = {
    moneyline: {}, totals: {}, spreads: { home: {}, away: {} }, periods: {},
    rawBookmakers: [{ id: row.provider?.id || bookmaker, name: bookmaker }],
  };
  const homeMoneyline = closingOdd(row.moneyline?.home);
  const awayMoneyline = closingOdd(row.moneyline?.away);
  if (homeMoneyline) result.moneyline.home = { odd: homeMoneyline, bookmaker };
  if (awayMoneyline) result.moneyline.away = { odd: awayMoneyline, bookmaker };

  const totalLine = Number(row.overUnder);
  const moreOdd = closingOdd(row.total?.over);
  const lessOdd = closingOdd(row.total?.under);
  if (Number.isFinite(totalLine) && (moreOdd || lessOdd)) {
    result.totals[totalLine] = {};
    if (moreOdd) result.totals[totalLine].over = { odd: moreOdd, bookmaker };
    if (lessOdd) result.totals[totalLine].under = { odd: lessOdd, bookmaker };
  }

  for (const side of ['home', 'away']) {
    const line = Number.parseFloat(row.pointSpread?.[side]?.close?.line ?? row.pointSpread?.[side]?.open?.line);
    const odd = closingOdd(row.pointSpread?.[side]);
    if (Number.isFinite(line) && odd) result.spreads[side][line] = { odd, bookmaker };
  }
  return result;
}

export function normalizeEspnGame(raw, competitionKey, requestedDate) {
  const config = COMPETITIONS[competitionKey];
  if (!config) throw new Error(`Competición ESPN inválida: ${competitionKey}`);
  const competition = raw.competitions?.[0] || {};
  const homeRaw = (competition.competitors || []).find((team) => team.homeAway === 'home') || {};
  const awayRaw = (competition.competitors || []).find((team) => team.homeAway === 'away') || {};
  const home = teamShape(homeRaw, config);
  const away = teamShape(awayRaw, config);
  const status = statusShape(raw.status || competition.status);
  const date = raw.date || competition.date || `${requestedDate}T12:00:00Z`;
  return {
    id: canonicalFixtureId(config, requestedDate, raw, home, away),
    providerFixtureId: String(raw.id || competition.id),
    dataProvider: `espn-${config.key}`,
    date,
    season: seasonFor(config, date, raw.season),
    league: {
      id: config.id,
      name: config.name,
      logo: raw.league?.logos?.[0]?.href || null,
      providerLeagueId: config.providerLeagueId,
    },
    country: { name: 'Estados Unidos' },
    status,
    teams: { home, away },
    scores: {
      home: { total: scoreValue(homeRaw, status) },
      away: { total: scoreValue(awayRaw, status) },
    },
    periods: { home: periodScores(homeRaw), away: periodScores(awayRaw) },
    raw,
  };
}

async function espnFetch(path, cacheKey, ttl) {
  try {
    const cached = await redisGet(cacheKey);
    if (cached && typeof cached === 'object') return cached;
  } catch {}
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${API}${path}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'CFAnalisis/1.0 (+https://cfanalisis.com)' },
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`ESPN HTTP ${response.status}`);
      const payload = await response.json();
      try { await redisSet(cacheKey, payload, ttl); } catch {}
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError || new Error('ESPN no disponible');
}

export async function getEspnGamesByDate(competitionKey, date, options = {}) {
  const config = COMPETITIONS[competitionKey];
  if (!config) throw new Error(`Competición ESPN inválida: ${competitionKey}`);
  const params = new URLSearchParams({ dates: date.replaceAll('-', ''), limit: '1000' });
  if (config.group) params.set('groups', String(config.group));
  const ttl = options.ttl ?? 900;
  const payload = await espnFetch(
    `/${config.sport}/${config.league}/scoreboard?${params}`,
    `espn:${competitionKey}:scoreboard:${date}`,
    ttl,
  );
  return (payload.events || []).map((event) => normalizeEspnGame(event, competitionKey, date));
}

function detailTeamShape(rawTeam, config) {
  const team = teamShape({ team: rawTeam?.team || rawTeam }, config);
  return {
    team,
    statistics: (rawTeam?.statistics || []).map((stat) => {
      const value = stat.value == null || stat.value === '' || stat.value === '-'
        ? stat.displayValue
        : stat.value;
      return { name: stat.name || stat.label || stat.abbreviation, value };
    }),
  };
}

function playerGroups(payload, config) {
  return (payload?.boxscore?.players || []).map((teamRow) => {
    const team = teamShape({ team: teamRow.team }, config);
    const players = (teamRow.statistics || []).flatMap((group) => {
      const labels = group.names || group.labels || [];
      return (group.athletes || []).map((row) => {
        const athlete = row.athlete || {};
        const stats = Object.fromEntries(labels.map((label, index) => [label, row.stats?.[index] ?? null]));
        return {
          id: `${config.teamPrefix}:PLAYER:${athlete.id || slug(athlete.displayName)}`,
          name: athlete.displayName || athlete.shortName || athlete.fullName || null,
          photo: athlete.headshot?.href || null,
          position: athlete.position?.abbreviation || athlete.position?.name || group.name || null,
          starter: row.starter === true,
          stats,
        };
      });
    });
    return { team, players };
  });
}

export async function getEspnGameDetails(game, options = {}) {
  const competitionKey = String(game?.dataProvider || '').replace(/^espn-/, '');
  const config = COMPETITIONS[competitionKey];
  if (!config || !game?.providerFixtureId) return null;
  const ttl = options.ttl ?? (game.status?.isFinal ? 86400 : 120);
  const params = new URLSearchParams({ event: String(game.providerFixtureId) });
  const payload = await espnFetch(
    `/${config.sport}/${config.league}/summary?${params}`,
    `espn:${competitionKey}:summary:${game.providerFixtureId}`,
    ttl,
  );
  const teams = (payload?.boxscore?.teams || []).map((row) => detailTeamShape(row, config));
  const players = playerGroups(payload, config);
  return {
    source: `espn-${competitionKey}`,
    teams,
    players,
    plays: payload?.plays || [],
    raw: payload,
  };
}

export function espnCompetitionKeysForSport(sport) {
  if (sport === 'basketball') return ['nba', 'ncaa'];
  if (sport === 'american_football') return ['nfl', 'ncaa-fbs', 'ncaa-fcs'];
  return [];
}

export const espnSportsInternals = {
  COMPETITIONS,
  NFL_TEAMS,
  normalizedName,
  slug,
  statusShape,
  teamShape,
  americanToDecimal,
};
