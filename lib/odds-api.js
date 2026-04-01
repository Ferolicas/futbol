// ===================== THE ODDS API INTEGRATION =====================
// Fetches real betting odds from The Odds API (https://the-odds-api.com)
// Used as a complementary/primary source of odds alongside API-Football.

const BASE_URL = 'https://api.the-odds-api.com/v4';

function getApiKey() {
  return process.env.THE_ODDS_API_KEY;
}

// Map API-Football league IDs → The Odds API sport keys
const LEAGUE_TO_SPORT_KEY = {
  // International
  1: 'soccer_fifa_world_cup',
  // UEFA
  2: 'soccer_uefa_champs_league',
  3: 'soccer_uefa_europa_league',
  848: 'soccer_uefa_europa_conference_league',
  // CONMEBOL
  13: 'soccer_conmebol_copa_libertadores',
  // England
  39: 'soccer_epl',
  40: 'soccer_england_efl_cup',
  45: 'soccer_fa_cup',
  // Spain
  140: 'soccer_spain_la_liga',
  141: 'soccer_spain_segunda_division',
  // Germany
  78: 'soccer_germany_bundesliga',
  79: 'soccer_germany_bundesliga2',
  // Italy
  135: 'soccer_italy_serie_a',
  136: 'soccer_italy_serie_b',
  // France
  61: 'soccer_france_ligue_one',
  62: 'soccer_france_ligue_two',
  // Turkey
  203: 'soccer_turkey_super_league',
  // Mexico
  262: 'soccer_mexico_ligamx',
  // Brazil
  71: 'soccer_brazil_serie_a',
  // Argentina
  128: 'soccer_argentina_primera_division',
  // Saudi Arabia
  307: 'soccer_saudi_professional_league',
  // Colombia
  239: 'soccer_colombia_primera_a',
  240: 'soccer_colombia_primera_b',
  // Copa Sudamericana
  11: 'soccer_conmebol_copa_sudamericana',
  // USA
  253: 'soccer_usa_mls',
  // Portugal
  94: 'soccer_portugal_primeira_liga',
  // Netherlands
  88: 'soccer_netherlands_eredivisie',
  // Belgium
  144: 'soccer_belgium_first_div_a',
  // Scotland
  179: 'soccer_scotland_premiership',
  // Greece
  197: 'soccer_greece_super_league',
  // Russia
  235: 'soccer_russia_premier_league',
  // Japan
  98: 'soccer_japan_j_league',
  // South Korea
  292: 'soccer_south_korea_kleague1',
  // Australia
  188: 'soccer_australia_aleague',
};

// Get the unique sport keys we need to query
function getSportKeysForLeagues(leagueIds) {
  const keys = new Set();
  for (const lid of leagueIds) {
    const key = LEAGUE_TO_SPORT_KEY[lid];
    if (key) keys.add(key);
  }
  return [...keys];
}

/**
 * Fetch available sports from The Odds API (free, doesn't count against quota)
 */
export async function fetchAvailableSports() {
  const key = getApiKey();
  if (!key) return [];

  try {
    const res = await fetch(`${BASE_URL}/sports?apiKey=${key}`, { cache: 'no-store' });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

/**
 * Fetch odds for a specific sport key from The Odds API.
 * Markets: h2h (1X2), totals (over/under goals)
 * Regions: eu (European bookmakers like bet365, bwin)
 *
 * @param {string} sportKey - The Odds API sport key
 * @param {object} options - { markets, regions, oddsFormat }
 * @returns {{ events: Array, remaining: number, used: number }}
 */
export async function fetchOddsForSport(sportKey, options = {}) {
  const key = getApiKey();
  if (!key) return { events: [], remaining: 0, used: 0 };

  const {
    markets = 'h2h,totals',
    regions = 'eu,uk',
    oddsFormat = 'decimal',
  } = options;

  try {
    const url = `${BASE_URL}/sports/${sportKey}/odds/?apiKey=${key}&regions=${regions}&markets=${markets}&oddsFormat=${oddsFormat}`;
    const res = await fetch(url, { cache: 'no-store' });

    if (!res.ok) {
      console.error(`[ODDS-API] Error for ${sportKey}: ${res.status}`);
      return { events: [], remaining: 0, used: 0 };
    }

    const events = await res.json();
    const remaining = parseInt(res.headers.get('x-requests-remaining') || '0', 10);
    const used = parseInt(res.headers.get('x-requests-used') || '0', 10);

    return { events: events || [], remaining, used };
  } catch (err) {
    console.error(`[ODDS-API] Fetch error for ${sportKey}:`, err.message);
    return { events: [], remaining: 0, used: 0 };
  }
}

/**
 * Normalize team names for fuzzy matching between API-Football and The Odds API.
 * Strips common suffixes, lowercases, removes accents.
 */
function normalizeTeamName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents
    .replace(/\b(fc|cf|sc|ac|rc|as|ss|us|cd|ud|sd|ca|se|rcd|afc|bsc|vfb|tsv|sv|fk|nk|sk|bk|if|ik|gf|bf|rb|rsc|og|kv|krc|kaa|zsc)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Match a fixture (from API-Football) to a The Odds API event by team name similarity.
 *
 * @param {{ home: string, away: string, date: string }} fixture
 * @param {Array} oddsEvents - Events from The Odds API
 * @returns {object|null} The matched event or null
 */
function matchFixtureToEvent(fixture, oddsEvents) {
  const homeNorm = normalizeTeamName(fixture.home);
  const awayNorm = normalizeTeamName(fixture.away);

  // Phase 1: exact substring match
  for (const ev of oddsEvents) {
    const evHome = normalizeTeamName(ev.home_team);
    const evAway = normalizeTeamName(ev.away_team);
    if (
      (evHome.includes(homeNorm) || homeNorm.includes(evHome)) &&
      (evAway.includes(awayNorm) || awayNorm.includes(evAway))
    ) {
      return ev;
    }
  }

  // Phase 2: word overlap scoring
  const homeWords = homeNorm.split(' ').filter(w => w.length > 2);
  const awayWords = awayNorm.split(' ').filter(w => w.length > 2);

  let bestMatch = null;
  let bestScore = 0;

  for (const ev of oddsEvents) {
    const evHomeWords = normalizeTeamName(ev.home_team).split(' ').filter(w => w.length > 2);
    const evAwayWords = normalizeTeamName(ev.away_team).split(' ').filter(w => w.length > 2);

    const homeOverlap = homeWords.filter(w => evHomeWords.some(ew => ew.includes(w) || w.includes(ew))).length;
    const awayOverlap = awayWords.filter(w => evAwayWords.some(ew => ew.includes(w) || w.includes(ew))).length;
    const score = homeOverlap + awayOverlap;

    if (score > bestScore && score >= 2) {
      bestScore = score;
      bestMatch = ev;
    }
  }

  return bestMatch;
}

/**
 * Extract structured odds from a The Odds API event.
 * Returns odds in the same format used by the app (compatible with bookmakers.js).
 *
 * @param {object} event - A single event from The Odds API
 * @returns {object} Normalized odds object
 */
function extractEventOdds(event) {
  if (!event?.bookmakers?.length) return null;

  const result = {
    bookmaker: null,
    matchWinner: null,
    overUnder: null,
    btts: null,
    allBookmakerOdds: [],
  };

  for (const bk of event.bookmakers) {
    const entry = {
      id: bk.key,
      name: bk.title,
      lastUpdate: bk.last_update,
    };

    for (const market of (bk.markets || [])) {
      if (market.key === 'h2h') {
        // Match Winner (1X2): outcomes are [home, away, draw]
        entry.matchWinner = {};
        for (const outcome of market.outcomes) {
          if (outcome.name === event.home_team) entry.matchWinner.home = outcome.price;
          else if (outcome.name === event.away_team) entry.matchWinner.away = outcome.price;
          else if (outcome.name === 'Draw') entry.matchWinner.draw = outcome.price;
        }
      }

      if (market.key === 'totals') {
        // Goals Over/Under — normalize points to standard thresholds
        if (!entry.overUnder) entry.overUnder = {};
        for (const outcome of market.outcomes) {
          const point = outcome.point || 2.5;
          const side = outcome.name; // "Over" or "Under"
          // Normalize Asian points (2.25 → 2.5, 2.75 → 2.5) to standard
          const normalized = Math.round(point * 2) / 2; // Round to nearest 0.5
          const key = `${side}_${String(normalized).replace('.', '_')}`;
          // Only store if we don't already have this key (prefer exact match)
          if (!entry.overUnder[key]) {
            entry.overUnder[key] = outcome.price;
          }
        }
      }
    }

    if (entry.matchWinner || entry.overUnder) {
      result.allBookmakerOdds.push(entry);
    }
  }

  // Select primary bookmaker (prefer bwin, bet365, pinnacle)
  const preferred = ['bwin', 'bet365', 'pinnacle', '1xbet', 'william hill', 'betfair'];
  let primary = null;
  for (const pref of preferred) {
    primary = result.allBookmakerOdds.find(bk => bk.name?.toLowerCase().includes(pref));
    if (primary) break;
  }
  if (!primary && result.allBookmakerOdds.length > 0) {
    primary = result.allBookmakerOdds[0];
  }

  if (primary) {
    result.bookmaker = primary.name;
    result.matchWinner = primary.matchWinner;
  }

  // Merge overUnder from ALL bookmakers to get the widest range of points
  // (some offer 1.5, others 2.5, others 3.5 — we want all)
  const mergedOU = {};
  for (const bk of result.allBookmakerOdds) {
    if (!bk.overUnder) continue;
    for (const [key, value] of Object.entries(bk.overUnder)) {
      if (!mergedOU[key]) {
        mergedOU[key] = value;
      }
    }
  }
  result.overUnder = Object.keys(mergedOU).length > 0 ? mergedOU : (primary?.overUnder || null);

  return result;
}

/**
 * Fetch odds for all fixtures of the day, matching by team names.
 * This is the main function called by the cron job or analysis pipeline.
 *
 * @param {Array} fixtures - Array of API-Football fixtures for the day
 * @returns {{ oddsByFixture: object, apiCallsUsed: number, remaining: number }}
 */
export async function fetchOddsForFixtures(fixtures) {
  const key = getApiKey();
  if (!key) {
    console.warn('[ODDS-API] No API key configured');
    return { oddsByFixture: {}, apiCallsUsed: 0, remaining: 0 };
  }

  // Group fixtures by The Odds API sport key
  const fixturesBySport = {};
  for (const fx of fixtures) {
    const leagueId = fx.league?.id;
    const sportKey = LEAGUE_TO_SPORT_KEY[leagueId];
    if (!sportKey) continue;

    if (!fixturesBySport[sportKey]) fixturesBySport[sportKey] = [];
    fixturesBySport[sportKey].push(fx);
  }

  const sportKeys = Object.keys(fixturesBySport);
  if (sportKeys.length === 0) {
    return { oddsByFixture: {}, apiCallsUsed: 0, remaining: 0 };
  }

  const oddsByFixture = {};
  let totalRemaining = 0;
  let totalUsed = 0;

  // Fetch odds for each sport — use all regions for maximum bookmaker coverage
  for (const sportKey of sportKeys) {
    const { events, remaining, used } = await fetchOddsForSport(sportKey, {
      markets: 'h2h,totals',
      regions: 'eu,uk,us,au',
    });
    totalRemaining = remaining;
    totalUsed = used;

    if (events.length === 0) continue;

    // Match fixtures to events
    for (const fx of fixturesBySport[sportKey]) {
      const homeName = fx.teams?.home?.name;
      const awayName = fx.teams?.away?.name;
      if (!homeName || !awayName) continue;

      const matched = matchFixtureToEvent(
        { home: homeName, away: awayName, date: fx.fixture?.date },
        events
      );

      if (matched) {
        const odds = extractEventOdds(matched);
        if (odds && (odds.matchWinner || odds.overUnder)) {
          oddsByFixture[fx.fixture.id] = {
            ...odds,
            source: 'the-odds-api',
            eventId: matched.id,
            commenceTime: matched.commence_time,
            fetchedAt: new Date().toISOString(),
          };
        }
      }
    }
  }

  return {
    oddsByFixture,
    apiCallsUsed: sportKeys.length,
    remaining: totalRemaining,
    quotaUsed: totalUsed,
  };
}

/**
 * Calculate implied probability from decimal odds.
 * @param {number} decimalOdd - e.g. 1.45
 * @returns {number} Probability as percentage, e.g. 68.97
 */
export function impliedProbability(decimalOdd) {
  if (!decimalOdd || decimalOdd <= 1) return 0;
  return +(100 / decimalOdd).toFixed(1);
}

/**
 * Filter odds to only show bets with implied probability > threshold.
 * Per requirement: only show bets with >75% implied probability.
 *
 * @param {object} odds - Odds object with matchWinner, overUnder, etc.
 * @param {number} threshold - Minimum implied probability (default 75)
 * @returns {Array} Array of qualifying bets with format required by the UI
 */
export function filterHighProbabilityBets(odds, threshold = 75) {
  if (!odds) return [];

  const bets = [];
  const bookmaker = odds.bookmaker || 'N/A';

  // Match Winner
  if (odds.matchWinner) {
    const mw = odds.matchWinner;
    if (mw.home && impliedProbability(mw.home) >= threshold) {
      bets.push({
        market: '1X2',
        selection: 'Victoria Local',
        odd: mw.home,
        probability: impliedProbability(mw.home),
        bookmaker,
      });
    }
    if (mw.draw && impliedProbability(mw.draw) >= threshold) {
      bets.push({
        market: '1X2',
        selection: 'Empate',
        odd: mw.draw,
        probability: impliedProbability(mw.draw),
        bookmaker,
      });
    }
    if (mw.away && impliedProbability(mw.away) >= threshold) {
      bets.push({
        market: '1X2',
        selection: 'Victoria Visitante',
        odd: mw.away,
        probability: impliedProbability(mw.away),
        bookmaker,
      });
    }
  }

  // Over/Under Goals
  if (odds.overUnder) {
    for (const [key, value] of Object.entries(odds.overUnder)) {
      const prob = impliedProbability(value);
      if (prob >= threshold) {
        const label = key.replace(/_/g, ' ').replace(/(\d) (\d)/g, '$1.$2');
        bets.push({
          market: 'Goles',
          selection: label,
          odd: value,
          probability: prob,
          bookmaker,
        });
      }
    }
  }

  return bets.sort((a, b) => b.probability - a.probability);
}

export { LEAGUE_TO_SPORT_KEY, normalizeTeamName, matchFixtureToEvent };
