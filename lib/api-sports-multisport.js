// Cliente compartido para los productos independientes de API-Sports.
// Cada host mantiene cuota diaria, circuito y cache separados. Los errores del
// proveedor nunca se devuelven ni se persisten como si fueran datos deportivos.

import { redisAcquireRateSlot, redisGet, redisIncr, redisSet } from './redis.js';

const PROVIDERS = Object.freeze({
  // API-NBA es un producto distinto de API-Basketball y dispone de su propia
  // cuota diaria. Se usa para hechos NBA; API-Basketball queda para cuotas.
  nba: { host: 'v2.nba.api-sports.io', label: 'API-NBA' },
  basketball: { host: 'v1.basketball.api-sports.io', label: 'API-Basketball' },
  baseball: { host: 'v1.baseball.api-sports.io', label: 'API-Baseball' },
  american_football: { host: 'v1.american-football.api-sports.io', label: 'API-NFL' },
});

const DEFAULT_DAILY_BUDGET = 90; // plan free=100; reserva 10 para recuperación manual
const DEFAULT_MIN_INTERVAL_MS = 6_500; // <= 10 solicitudes/minuto en planes free
const DEFAULT_MINUTE_PAUSE_MS = 60_000;
const RESET_GRACE_SECONDS = 5;
const memoryCache = new Map();
const memoryCounters = new Map();
const memoryCircuits = new Map();
const memoryRateSlots = new Map();
const memoryMinutePauses = new Map();
const MAX_MEMORY_CACHE_ENTRIES = 2_000;

function remember(cacheKey, value, ttl) {
  const now = Date.now();
  if (memoryCache.size >= MAX_MEMORY_CACHE_ENTRIES) {
    for (const [key, item] of memoryCache) {
      if (item.expiresAt <= now) memoryCache.delete(key);
    }
  }
  while (memoryCache.size >= MAX_MEMORY_CACHE_ENTRIES) {
    memoryCache.delete(memoryCache.keys().next().value);
  }
  memoryCache.set(cacheKey, { value, expiresAt: now + ttl * 1000 });
}

function apiKey(provider) {
  const providerEnv = `API_SPORTS_${provider.toUpperCase()}_KEY`;
  const aliases = {
    nba: 'API_NBA_KEY',
    basketball: 'API_BASKETBALL_KEY',
    baseball: 'API_BASEBALL_KEY',
    american_football: 'API_NFL_KEY',
  };
  return process.env[providerEnv]
    || process.env[aliases[provider]]
    || process.env.API_SPORTS_KEY
    || process.env.FOOTBALL_API_KEY
    || '';
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function secondsUntilUtcReset() {
  const now = new Date();
  const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60, Math.ceil((reset - now.getTime()) / 1000) + RESET_GRACE_SECONDS);
}

function dailyBudget(provider) {
  const envKey = `API_SPORTS_${provider.toUpperCase()}_DAILY_BUDGET`;
  const value = Number(process.env[envKey] || process.env.API_SPORTS_DAILY_BUDGET || DEFAULT_DAILY_BUDGET);
  return Number.isFinite(value) ? Math.max(1, Math.min(99, Math.floor(value))) : DEFAULT_DAILY_BUDGET;
}

function providerMinInterval(provider) {
  const envKey = `API_SPORTS_${provider.toUpperCase()}_MIN_INTERVAL_MS`;
  const value = Number(process.env[envKey] || process.env.API_SPORTS_MIN_INTERVAL_MS || DEFAULT_MIN_INTERVAL_MS);
  return Number.isFinite(value) ? Math.max(0, Math.min(60_000, Math.floor(value))) : DEFAULT_MIN_INTERVAL_MS;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForProviderSlot(provider) {
  const interval = providerMinInterval(provider);
  if (interval <= 0) return;
  const pauseKey = `apisports:${provider}:minute-pause`;
  const slotKey = `apisports:${provider}:rate-slot`;

  while (true) {
    const sharedPause = await redisGet(pauseKey);
    const pauseUntil = Math.max(
      Number(sharedPause?.until || 0),
      Number(memoryMinutePauses.get(provider) || 0),
    );
    if (pauseUntil > Date.now()) {
      await delay(pauseUntil - Date.now() + 25);
      continue;
    }

    const sharedWait = await redisAcquireRateSlot(slotKey, interval);
    if (sharedWait === 0) return;
    if (sharedWait != null && sharedWait > 0) {
      await delay(sharedWait + 25);
      continue;
    }

    // Redis caído: conserva el límite dentro del proceso como degradación
    // segura. No es tan fuerte como el slot distribuido, pero evita ráfagas.
    const next = Number(memoryRateSlots.get(provider) || 0);
    if (next <= Date.now()) {
      memoryRateSlots.set(provider, Date.now() + interval);
      return;
    }
    await delay(next - Date.now() + 25);
  }
}

function classifyProviderLimit(status, errors) {
  const message = (errors || []).join(' ').toLowerCase();
  if (/request limit[^.]*for the day|limit for the day|per day|daily (?:request |)limit|daily quota|quota[^.]*day/.test(message)) return 'daily';
  if (Number(status) === 429 || /per minute|requests per minute|too many requests|rate[ -]?limit/.test(message)) return 'minute';
  return null;
}

async function pauseMinuteLimit(provider) {
  const configured = Number(process.env.API_SPORTS_MINUTE_PAUSE_MS || DEFAULT_MINUTE_PAUSE_MS);
  const pauseMs = Number.isFinite(configured) ? Math.max(1_000, Math.min(120_000, Math.floor(configured))) : DEFAULT_MINUTE_PAUSE_MS;
  const until = Date.now() + pauseMs;
  memoryMinutePauses.set(provider, until);
  await redisSet(`apisports:${provider}:minute-pause`, { until }, Math.ceil(pauseMs / 1000) + 5);
  return pauseMs;
}

function nonEmptyErrors(errors) {
  if (!errors) return [];
  if (Array.isArray(errors)) return errors.filter(Boolean).map(String);
  if (typeof errors === 'object') return Object.entries(errors)
    .filter(([, value]) => value != null && String(value).trim())
    .map(([key, value]) => `${key}: ${value}`);
  return String(errors).trim() ? [String(errors)] : [];
}

function queryString(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    if (Array.isArray(value)) value.forEach((v) => search.append(key, String(v)));
    else search.set(key, String(value));
  }
  return search.toString();
}

function stableParams(params = {}) {
  return Object.keys(params).sort().map((key) => `${key}=${Array.isArray(params[key]) ? params[key].join(',') : params[key]}`).join('&');
}

export class ApiSportsProviderError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApiSportsProviderError';
    this.details = details;
  }
}

export async function getApiSportsQuota(provider) {
  if (!PROVIDERS[provider]) throw new Error(`Proveedor API-Sports inválido: ${provider}`);
  const redisUsed = Number(await redisGet(`apisports:${provider}:used:${utcDay()}`));
  const used = Number.isFinite(redisUsed) && redisUsed > 0
    ? redisUsed
    : Number(memoryCounters.get(`${provider}:${utcDay()}`) || 0);
  const budget = dailyBudget(provider);
  return { provider, used, budget, remaining: Math.max(0, budget - used), date: utcDay() };
}

export async function apiSportsRequest(provider, path, params = {}, options = {}) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Proveedor API-Sports inválido: ${provider}`);
  const key = apiKey(provider);
  if (!key) throw new ApiSportsProviderError(`Falta clave API-Sports para ${provider}`, { provider });

  const cacheKey = options.cacheKey || `apisports:${provider}:cache:${path}:${stableParams(params)}`;
  if (options.ttl !== 0) {
    const cached = await redisGet(cacheKey);
    if (cached?.response && Array.isArray(cached.response)) {
      return { ...cached, meta: { ...(cached.meta || {}), cached: true } };
    }
    const local = memoryCache.get(cacheKey);
    if (local && local.expiresAt > Date.now()) return { ...local.value, meta: { ...(local.value.meta || {}), cached: true, memory: true } };
  }

  const circuitKey = `apisports:${provider}:circuit:${utcDay()}`;
  const circuit = await redisGet(circuitKey) || memoryCircuits.get(circuitKey);
  if (circuit) throw new ApiSportsProviderError(`${cfg.label}: circuito diario abierto`, { provider, circuit });

  await waitForProviderSlot(provider);

  const budget = dailyBudget(provider);
  const counterKey = `${provider}:${utcDay()}`;
  let count = await redisIncr(`apisports:${provider}:used:${utcDay()}`, secondsUntilUtcReset());
  if (count == null) {
    count = Number(memoryCounters.get(counterKey) || 0) + 1;
    memoryCounters.set(counterKey, count);
  } else {
    memoryCounters.set(counterKey, Math.max(count, Number(memoryCounters.get(counterKey) || 0)));
  }
  if (count > budget) {
    memoryCircuits.set(circuitKey, { reason: 'local_daily_budget', count, budget });
    await redisSet(circuitKey, { reason: 'local_daily_budget', count, budget }, secondsUntilUtcReset());
    throw new ApiSportsProviderError(`${cfg.label}: presupuesto diario local agotado`, { provider, count, budget });
  }

  const qs = queryString(params);
  const url = `https://${cfg.host}${path}${qs ? `?${qs}` : ''}`;
  let response;
  try {
    response = await fetch(url, {
      headers: { 'x-apisports-key': key, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(options.timeoutMs || 20_000),
    });
  } catch (error) {
    throw new ApiSportsProviderError(`${cfg.label}: ${error.message}`, { provider, path, cause: error.message });
  }

  let payload;
  try { payload = await response.json(); }
  catch { throw new ApiSportsProviderError(`${cfg.label}: respuesta no JSON (${response.status})`, { provider, path }); }

  const providerErrors = nonEmptyErrors(payload?.errors);
  if (!response.ok || providerErrors.length) {
    const limitType = classifyProviderLimit(response.status, providerErrors);
    let retryAfterMs = null;
    if (limitType === 'daily') {
      memoryCircuits.set(circuitKey, { reason: 'provider_quota', status: response.status, errors: providerErrors });
      await redisSet(circuitKey, { reason: 'provider_quota', status: response.status, errors: providerErrors }, secondsUntilUtcReset());
    } else if (limitType === 'minute') {
      retryAfterMs = await pauseMinuteLimit(provider);
    }
    throw new ApiSportsProviderError(
      `${cfg.label}: ${providerErrors.join('; ') || `HTTP ${response.status}`}`,
      { provider, path, status: response.status, errors: providerErrors, limitType, retryAfterMs },
    );
  }

  if (!Array.isArray(payload?.response)) {
    throw new ApiSportsProviderError(`${cfg.label}: contrato inválido (response no es array)`, { provider, path });
  }

  const clean = {
    response: payload.response,
    results: Number(payload.results ?? payload.response.length),
    paging: payload.paging || null,
    meta: {
      provider: cfg.label,
      cached: false,
      fetchedAt: new Date().toISOString(),
      quota: {
        localUsed: count,
        localBudget: budget,
        remaining: Number(response.headers.get('x-ratelimit-requests-remaining') || NaN),
      },
    },
  };
  if (options.ttl !== 0) {
    const ttl = options.ttl || 600;
    remember(cacheKey, clean, ttl);
    await redisSet(cacheKey, clean, ttl);
  }
  return clean;
}

export const apiSportsInternals = {
  classifyProviderLimit,
  providerMinInterval,
};

export async function getApiSportsGamesByDate(provider, date, options = {}) {
  return apiSportsRequest(provider, '/games', { date, ...(options.params || {}) }, {
    ttl: options.ttl ?? 600,
    cacheKey: `apisports:${provider}:games:${date}:${stableParams(options.params || {})}`,
  });
}

export async function getApiSportsGame(provider, gameId, options = {}) {
  return apiSportsRequest(provider, '/games', { id: gameId }, {
    ttl: options.ttl ?? 120,
    cacheKey: `apisports:${provider}:game:${gameId}`,
  });
}

export async function getApiSportsGameStatistics(provider, gameId, options = {}) {
  const path = provider === 'nba' ? '/games/statistics' : '/games/statistics/teams';
  return apiSportsRequest(provider, path, { id: gameId }, {
    ttl: options.ttl ?? 1800,
    cacheKey: `apisports:${provider}:stats:${gameId}`,
  });
}

export async function getApiSportsPlayerStatistics(provider, gameId, options = {}) {
  const path = provider === 'nba' ? '/players/statistics' : '/games/statistics/players';
  const params = provider === 'nba' ? { game: gameId } : { id: gameId };
  return apiSportsRequest(provider, path, params, {
    ttl: options.ttl ?? 1800,
    cacheKey: `apisports:${provider}:players:${gameId}`,
  });
}

export async function getApiSportsOddsForGame(provider, gameId, options = {}) {
  return apiSportsRequest(provider, '/odds', { game: gameId }, {
    ttl: options.ttl ?? 1800,
    cacheKey: `apisports:${provider}:odds:${gameId}`,
  });
}

function normalizeBookmaker(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function allowedBookmaker(name, configuredNames) {
  const configured = (Array.isArray(configuredNames)
    ? configuredNames
    : String(process.env.API_SPORTS_ALLOWED_BOOKMAKERS || 'bet365,bwin').split(','))
    .map(normalizeBookmaker).filter(Boolean);
  const normalized = normalizeBookmaker(name);
  return configured.some((item) => normalized.includes(item) || item.includes(normalized));
}

function numericOdd(value) {
  const odd = Number(value);
  return Number.isFinite(odd) && odd > 1 ? odd : null;
}

function parseLine(value) {
  const match = String(value || '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function bestSet(target, key, odd, bookmaker, metadata = {}) {
  if (!odd) return;
  if (!target[key] || odd > target[key].odd) target[key] = { odd, bookmaker, ...metadata };
}

function marketMetadata(bookmaker, bet, item, family, extra = {}) {
  return {
    bookmakerId: bookmaker.id ?? null,
    marketId: bet.id ?? null,
    marketName: String(bet.name || ''),
    selectionName: String(item.value || ''),
    family,
    ...extra,
  };
}

function rememberCatalog(result, bookmaker, bet, item, odd, family, extra = {}) {
  result.catalog.push({
    odd,
    bookmaker: bookmaker.name,
    ...marketMetadata(bookmaker, bet, item, family, extra),
  });
}

function exactMarketName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// API-Baseball publica muchos mercados que contienen las palabras "total" u
// "over/under". No son equivalentes: Total Hits, Result/Total Goals y el total
// de cada equipo no pueden mezclarse con el total de carreras del partido.
// Los IDs y nombres siguientes corresponden al catálogo real de Bet365 que
// entrega API-Baseball; solo se normalizan familias que el motor sabe medir.
function normalizeBaseballBet365Item(result, bookmaker, bet, item, odd, fixture) {
  const marketId = Number(bet.id);
  const market = exactMarketName(bet.name);
  const isExactMarket = (expectedId, expectedName) => market === expectedName
    && (!Number.isFinite(marketId) || marketId === expectedId);
  const label = String(item.value || '').trim();
  const normalizedLabel = label.toLowerCase();
  const line = parseLine(label);
  const side = /\bunder\b|\bmenos\b/.test(normalizedLabel)
    ? 'under'
    : (/\bover\b|\bmas\b|\bmás\b/.test(normalizedLabel) ? 'over' : null);
  const homeName = String(fixture.home?.name || fixture.teams?.home?.name || '').toLowerCase();
  const awayName = String(fixture.away?.name || fixture.teams?.away?.name || '').toLowerCase();
  const selectionTeam = /^home\b|^1\b|\blocal\b/.test(normalizedLabel)
    || (homeName && normalizedLabel.includes(homeName))
    ? 'home'
    : (/^away\b|^2\b|\bvisit/.test(normalizedLabel)
      || (awayName && normalizedLabel.includes(awayName)) ? 'away' : null);

  if (isExactMarket(1, 'home/away')) {
    if (!selectionTeam) return true;
    const metadata = marketMetadata(bookmaker, bet, item, 'moneyline', { team: selectionTeam });
    bestSet(result.moneyline, selectionTeam, odd, bookmaker.name, metadata);
    rememberCatalog(result, bookmaker, bet, item, odd, 'moneyline', { team: selectionTeam });
    return true;
  }

  if (isExactMarket(5, 'over/under')) {
    if (line == null || !side) return true;
    result.totals[line] ||= {};
    const metadata = marketMetadata(bookmaker, bet, item, 'game_total', { side, line });
    bestSet(result.totals[line], side, odd, bookmaker.name, metadata);
    rememberCatalog(result, bookmaker, bet, item, odd, 'game_total', { side, line });
    return true;
  }

  if (isExactMarket(2, 'asian handicap')) {
    if (line == null || !selectionTeam) return true;
    result.spreads[selectionTeam] ||= {};
    const metadata = marketMetadata(bookmaker, bet, item, 'asian_handicap', { team: selectionTeam, line });
    bestSet(result.spreads[selectionTeam], line, odd, bookmaker.name, metadata);
    rememberCatalog(result, bookmaker, bet, item, odd, 'asian_handicap', { team: selectionTeam, line });
    return true;
  }

  if (isExactMarket(6, 'over/under (1st 5 innings)')) {
    if (line == null || !side) return true;
    result.periods.first5 ||= { totals: {}, spreads: {} };
    result.periods.first5.totals[line] ||= {};
    const metadata = marketMetadata(bookmaker, bet, item, 'first5_total', { side, line, period: 'first5' });
    bestSet(result.periods.first5.totals[line], side, odd, bookmaker.name, metadata);
    rememberCatalog(result, bookmaker, bet, item, odd, 'first5_total', { side, line, period: 'first5' });
    return true;
  }

  if (isExactMarket(3, 'asian handicap (1st 5 innings)')) {
    if (line == null || !selectionTeam) return true;
    result.periods.first5 ||= { totals: {}, spreads: {} };
    result.periods.first5.spreads[selectionTeam] ||= {};
    const metadata = marketMetadata(bookmaker, bet, item, 'first5_handicap', { team: selectionTeam, line, period: 'first5' });
    bestSet(result.periods.first5.spreads[selectionTeam], line, odd, bookmaker.name, metadata);
    rememberCatalog(result, bookmaker, bet, item, odd, 'first5_handicap', { team: selectionTeam, line, period: 'first5' });
    return true;
  }

  const teamTotalSide = isExactMarket(43, 'home team total goals (including ot)')
    ? 'home'
    : (isExactMarket(44, 'away team total goals (including ot)') ? 'away' : null);
  if (teamTotalSide) {
    if (line == null || !side) return true;
    result.teamTotals[teamTotalSide][line] ||= {};
    const metadata = marketMetadata(bookmaker, bet, item, 'team_total', { team: teamTotalSide, side, line });
    bestSet(result.teamTotals[teamTotalSide][line], side, odd, bookmaker.name, metadata);
    rememberCatalog(result, bookmaker, bet, item, odd, 'team_total', { team: teamTotalSide, side, line });
    return true;
  }

  return false;
}

// Normaliza únicamente hechos de cuotas. Nunca mezcla probabilidad de mercado
// con la probabilidad estadística del motor.
export function normalizeApiSportsOdds(payload, fixture = {}, options = {}) {
  const rows = Array.isArray(payload) ? payload : (payload?.response || []);
  const result = {
    moneyline: {}, totals: {}, spreads: {}, periods: {},
    teamTotals: { home: {}, away: {} }, catalog: [], rawBookmakers: [],
  };
  const homeName = String(fixture.home?.name || fixture.teams?.home?.name || '').toLowerCase();
  const awayName = String(fixture.away?.name || fixture.teams?.away?.name || '').toLowerCase();
  const sport = String(options.sport || '').toLowerCase();

  for (const row of rows) {
    for (const bookmaker of row?.bookmakers || []) {
      if (!allowedBookmaker(bookmaker.name, options.bookmakers)) continue;
      result.rawBookmakers.push({ id: bookmaker.id, name: bookmaker.name });
      for (const bet of bookmaker.bets || []) {
        const market = String(bet.name || '').toLowerCase();
        for (const item of bet.values || []) {
          const label = String(item.value || '').toLowerCase();
          const odd = numericOdd(item.odd);
          if (!odd) continue;

          if (sport === 'baseball') {
            normalizeBaseballBet365Item(result, bookmaker, bet, item, odd, fixture);
            continue;
          }

          const isWinner = /home\/away|moneyline|money line|match winner|winner|ganador/.test(market)
            && !/half|quarter|inning|period|run line|handicap|spread/.test(market);
          if (isWinner) {
            if (/^home$|^1$|local/.test(label) || (homeName && label.includes(homeName))) bestSet(result.moneyline, 'home', odd, bookmaker.name, marketMetadata(bookmaker, bet, item, 'moneyline', { team: 'home' }));
            else if (/^away$|^2$|visit/.test(label) || (awayName && label.includes(awayName))) bestSet(result.moneyline, 'away', odd, bookmaker.name, marketMetadata(bookmaker, bet, item, 'moneyline', { team: 'away' }));
            else if (/draw|tie|empate|^x$/.test(label)) bestSet(result.moneyline, 'draw', odd, bookmaker.name, marketMetadata(bookmaker, bet, item, 'moneyline', { team: 'draw' }));
            continue;
          }

          const line = parseLine(item.value);
          if (line == null) continue;
          const side = /under|menos/.test(label) ? 'under' : (/over|mas|más/.test(label) ? 'over' : null);
          if (/total/.test(market) && side && !/team|home|away/.test(market)) {
            result.totals[line] ||= {};
            bestSet(result.totals[line], side, odd, bookmaker.name, marketMetadata(bookmaker, bet, item, 'game_total', { side, line }));
          } else if (/handicap|spread|run line/.test(market)) {
            const team = /home|local|^1\b/.test(label) ? 'home' : (/away|visit|^2\b/.test(label) ? 'away' : null);
            if (team) {
              result.spreads[team] ||= {};
              bestSet(result.spreads[team], line, odd, bookmaker.name, marketMetadata(bookmaker, bet, item, 'spread', { team, line }));
            }
          } else if (/half|quarter|inning|period/.test(market) && side) {
            const periodKey = market.replace(/[^a-z0-9]+/g, '_');
            result.periods[periodKey] ||= {};
            result.periods[periodKey][line] ||= {};
            bestSet(result.periods[periodKey][line], side, odd, bookmaker.name, marketMetadata(bookmaker, bet, item, 'period_total', { side, line, period: periodKey }));
          }
        }
      }
    }
  }
  result.rawBookmakers = [...new Map(result.rawBookmakers.map((b) => [b.id || b.name, b])).values()];
  result.catalog = [...new Map(result.catalog.map((entry) => [
    `${entry.bookmakerId || entry.bookmaker}:${entry.marketId || entry.marketName}:${entry.selectionName}`,
    entry,
  ])).values()];
  return result;
}
