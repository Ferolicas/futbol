// Cliente compartido para los productos independientes de API-Sports.
// Cada host mantiene cuota diaria, circuito y cache separados. Los errores del
// proveedor nunca se devuelven ni se persisten como si fueran datos deportivos.

import { redisGet, redisIncr, redisSet } from './redis.js';

const PROVIDERS = Object.freeze({
  // API-NBA es un producto distinto de API-Basketball y dispone de su propia
  // cuota diaria. Se usa para hechos NBA; API-Basketball queda para cuotas.
  nba: { host: 'v2.nba.api-sports.io', label: 'API-NBA' },
  basketball: { host: 'v1.basketball.api-sports.io', label: 'API-Basketball' },
  baseball: { host: 'v1.baseball.api-sports.io', label: 'API-Baseball' },
  american_football: { host: 'v1.american-football.api-sports.io', label: 'API-NFL' },
});

const DEFAULT_DAILY_BUDGET = 90; // plan free=100; reserva 10 para recuperación manual
const RESET_GRACE_SECONDS = 5;
const memoryCache = new Map();
const memoryCounters = new Map();
const memoryCircuits = new Map();
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
    const quotaError = providerErrors.some((message) => /limit|quota|request|plan|access|season|date/i.test(message));
    if (quotaError && /limit|quota|request/i.test(providerErrors.join(' '))) {
      memoryCircuits.set(circuitKey, { reason: 'provider_quota', status: response.status, errors: providerErrors });
      await redisSet(circuitKey, { reason: 'provider_quota', status: response.status, errors: providerErrors }, secondsUntilUtcReset());
    }
    throw new ApiSportsProviderError(
      `${cfg.label}: ${providerErrors.join('; ') || `HTTP ${response.status}`}`,
      { provider, path, status: response.status, errors: providerErrors },
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

function allowedBookmaker(name) {
  const configured = String(process.env.API_SPORTS_ALLOWED_BOOKMAKERS || 'bet365,bwin')
    .split(',').map(normalizeBookmaker).filter(Boolean);
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

function bestSet(target, key, odd, bookmaker) {
  if (!odd) return;
  if (!target[key] || odd > target[key].odd) target[key] = { odd, bookmaker };
}

// Normaliza únicamente hechos de cuotas. Nunca mezcla probabilidad de mercado
// con la probabilidad estadística del motor.
export function normalizeApiSportsOdds(payload, fixture = {}) {
  const rows = Array.isArray(payload) ? payload : (payload?.response || []);
  const result = { moneyline: {}, totals: {}, spreads: {}, periods: {}, rawBookmakers: [] };
  const homeName = String(fixture.home?.name || fixture.teams?.home?.name || '').toLowerCase();
  const awayName = String(fixture.away?.name || fixture.teams?.away?.name || '').toLowerCase();

  for (const row of rows) {
    for (const bookmaker of row?.bookmakers || []) {
      if (!allowedBookmaker(bookmaker.name)) continue;
      result.rawBookmakers.push({ id: bookmaker.id, name: bookmaker.name });
      for (const bet of bookmaker.bets || []) {
        const market = String(bet.name || '').toLowerCase();
        for (const item of bet.values || []) {
          const label = String(item.value || '').toLowerCase();
          const odd = numericOdd(item.odd);
          if (!odd) continue;

          const isWinner = /home\/away|moneyline|money line|match winner|winner|ganador/.test(market)
            && !/half|quarter|inning|period|run line|handicap|spread/.test(market);
          if (isWinner) {
            if (/^home$|^1$|local/.test(label) || (homeName && label.includes(homeName))) bestSet(result.moneyline, 'home', odd, bookmaker.name);
            else if (/^away$|^2$|visit/.test(label) || (awayName && label.includes(awayName))) bestSet(result.moneyline, 'away', odd, bookmaker.name);
            else if (/draw|tie|empate|^x$/.test(label)) bestSet(result.moneyline, 'draw', odd, bookmaker.name);
            continue;
          }

          const line = parseLine(item.value);
          if (line == null) continue;
          const side = /under|menos/.test(label) ? 'under' : (/over|mas|más/.test(label) ? 'over' : null);
          if (/total/.test(market) && side && !/team|home|away/.test(market)) {
            result.totals[line] ||= {};
            bestSet(result.totals[line], side, odd, bookmaker.name);
          } else if (/handicap|spread|run line/.test(market)) {
            const team = /home|local|^1\b/.test(label) ? 'home' : (/away|visit|^2\b/.test(label) ? 'away' : null);
            if (team) {
              result.spreads[team] ||= {};
              bestSet(result.spreads[team], line, odd, bookmaker.name);
            }
          } else if (/half|quarter|inning|period/.test(market) && side) {
            const periodKey = market.replace(/[^a-z0-9]+/g, '_');
            result.periods[periodKey] ||= {};
            result.periods[periodKey][line] ||= {};
            bestSet(result.periods[periodKey][line], side, odd, bookmaker.name);
          }
        }
      }
    }
  }
  result.rawBookmakers = [...new Map(result.rawBookmakers.map((b) => [b.id || b.name, b])).values()];
  return result;
}
