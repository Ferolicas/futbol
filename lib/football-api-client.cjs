/* eslint-disable */
// Cliente único de API-Football para web, workers y scripts.
//
// El slot se reserva en Redis mediante Lua, por lo que TODOS los procesos PM2
// comparten el mismo ritmo. El valor por defecto (420/min) deja margen frente
// al plan de 450/min. Si Redis falla, se degrada a un limitador local igualmente
// espaciado; nunca se devuelve/guarda un body de error como si fueran datos.

const IORedis = require('ioredis');

const API_HOST = 'v3.football.api-sports.io';
const GLOBAL_RATE_KEY = 'ratelimit:api-football:next-slot';
const RATE_PER_MINUTE = Math.max(1, Number(process.env.FOOTBALL_API_RATE_PER_MIN || 420));
const SLOT_MS = Math.ceil(60_000 / RATE_PER_MINUTE);
// Si Redis cae, cada proceso deja de poder coordinarse con los demás. El
// fallback es deliberadamente conservador: web + worker + scripts pueden
// coexistir sin que cada uno dispare 420/min por separado.
const FALLBACK_RATE_PER_MINUTE = Math.max(1, Math.min(100, Number(process.env.FOOTBALL_API_FALLBACK_RATE_PER_MIN || 80)));
const FALLBACK_SLOT_MS = Math.ceil(60_000 / FALLBACK_RATE_PER_MINUTE);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let redisClient = null;
let localNextSlot = 0;
let warnedRedisFallback = false;

const RESERVE_SLOT_LUA = `
local now = tonumber(ARGV[1])
local spacing = tonumber(ARGV[2])
local nextSlot = tonumber(redis.call('GET', KEYS[1]) or '0')
local slot = math.max(now, nextSlot)
redis.call('SET', KEYS[1], slot + spacing, 'PX', 600000)
return slot - now
`;

function getRedis() {
  if (redisClient) return redisClient;
  redisClient = new IORedis({
    host: process.env.LOCAL_REDIS_HOST || process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.LOCAL_REDIS_PORT || process.env.REDIS_PORT || 6379),
    password: process.env.LOCAL_REDIS_PASSWORD || process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  // El caller ya aplica fallback. Evita que ioredis emita un error sin listener.
  redisClient.on('error', () => {});
  return redisClient;
}

async function reserveFootballApiSlot() {
  let waitMs = 0;
  try {
    waitMs = Number(await getRedis().eval(RESERVE_SLOT_LUA, 1, GLOBAL_RATE_KEY, Date.now(), SLOT_MS)) || 0;
  } catch (error) {
    const now = Date.now();
    const slot = Math.max(now, localNextSlot);
    localNextSlot = slot + FALLBACK_SLOT_MS;
    waitMs = slot - now;
    if (!warnedRedisFallback) {
      warnedRedisFallback = true;
      console.warn(`[api-football] Redis limiter no disponible; fallback local: ${error?.message || error}`);
    }
  }
  if (waitMs > 0) await sleep(waitMs);
  return waitMs;
}

function apiErrorText(errors) {
  if (!errors) return '';
  if (Array.isArray(errors)) return errors.map(String).join('; ');
  if (typeof errors === 'object') return Object.values(errors).flat().map(String).join('; ');
  return String(errors);
}

function responseSize(payload) {
  const value = payload?.response;
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

function footballApiPath(endpoint, refId, subKey = '', season = null) {
  if (endpoint === 'fixtures') return `/fixtures?id=${refId}`;
  if (endpoint === 'fixtures/headtohead') return `/fixtures/headtohead?h2h=${refId}-${subKey}&last=8`;
  if (endpoint === 'teams/statistics') {
    const modern = String(subKey).match(/^s:(\d+):l:(\d+)$/);
    if (modern) return `/teams/statistics?team=${refId}&league=${modern[2]}&season=${modern[1]}`;
    const legacy = String(subKey).match(/^l:(\d+)$/);
    return legacy && season != null
      ? `/teams/statistics?team=${refId}&league=${legacy[1]}&season=${season}`
      : null;
  }
  if (endpoint === 'players') {
    const modern = String(subKey).match(/^s:(\d+):p:(\d+)$/);
    if (modern) return `/players?team=${refId}&season=${modern[1]}&page=${modern[2]}`;
    const legacy = String(subKey).match(/^p:(\d+)$/);
    return legacy && season != null
      ? `/players?team=${refId}&season=${season}&page=${legacy[1]}`
      : null;
  }
  if (endpoint === 'players/squads') return `/players/squads?team=${refId}`;
  if (endpoint === 'teams') return `/teams?id=${refId}`;
  if (endpoint === 'coachs') return `/coachs?team=${refId}`;
  if (endpoint === 'transfers') return `/transfers?team=${refId}`;
  if (endpoint === 'venues') {
    const venue = String(subKey).match(/^v:(\d+)$/)?.[1];
    return venue ? `/venues?id=${venue}` : null;
  }
  if (endpoint === 'injuries') {
    if (String(subKey).startsWith('team:')) return `/injuries?team=${refId}&season=${season || String(subKey).split(':')[1]}`;
    return `/injuries?fixture=${refId}`;
  }
  if (/^[a-z]+(?:\/[a-z]+)?$/i.test(String(endpoint))) return `/${endpoint}?fixture=${refId}`;
  return null;
}

function payloadQuality(payload) {
  if (!payload || typeof payload !== 'object') return 0;
  if (payload.__error || payload.__http) return 0;
  if (apiErrorText(payload.errors).trim()) return 0;
  // raw_api_payloads guarda tanto envelopes completos como objetos fixture
  // individuales. Un objeto real sin propiedad response también es dato útil.
  if (!Object.prototype.hasOwnProperty.call(payload, 'response')) {
    return Object.keys(payload).length > 0 ? 2 : 1;
  }
  return responseSize(payload) > 0 ? 2 : 1; // 2=datos; 1=respuesta válida vacía
}

class FootballApiError extends Error {
  constructor(message, { code = 'API_ERROR', status = null, retryable = false, path = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'FootballApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.path = path;
    this.retryAfterMs = retryAfterMs;
  }
}

async function footballApiRequest(path, options = {}) {
  const apiKey = options.apiKey || process.env.FOOTBALL_API_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
  if (!apiKey) throw new FootballApiError('FOOTBALL_API_KEY no configurada', { code: 'NO_API_KEY', path });
  const retries = Number.isFinite(Number(options.retries)) ? Number(options.retries) : 2;
  const timeoutMs = Number(options.timeoutMs || 30_000);

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await reserveFootballApiSlot();
    try {
      const response = await fetch(`https://${API_HOST}${path}`, {
        headers: { 'x-apisports-key': apiKey },
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      if (response.status === 429 || response.status >= 500) {
        throw new FootballApiError(`API HTTP ${response.status}`, {
          code: response.status === 429 ? 'RATE_LIMIT' : 'UPSTREAM_HTTP',
          status: response.status, retryable: true, path,
          retryAfterMs: Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : null,
        });
      }
      if (!response.ok) {
        throw new FootballApiError(`API HTTP ${response.status}`, {
          code: 'UPSTREAM_HTTP', status: response.status, retryable: false, path,
        });
      }

      const payload = await response.json();
      const errorText = apiErrorText(payload?.errors).trim();
      if (errorText) {
        const isRate = /rate|request|limit|too many/i.test(errorText);
        throw new FootballApiError(`API: ${errorText}`, {
          code: isRate ? 'RATE_LIMIT' : 'API_BODY_ERROR', retryable: isRate, path,
        });
      }
      const remainingHeader = response.headers.get('x-ratelimit-requests-remaining');
      const remaining = remainingHeader == null ? null : Number(remainingHeader);
      return {
        payload,
        response: payload?.response ?? [],
        remaining: Number.isFinite(remaining) ? remaining : null,
      };
    } catch (error) {
      lastError = error instanceof FootballApiError
        ? error
        : new FootballApiError(error?.message || String(error), { code: 'NETWORK', retryable: true, path });
      if (!lastError.retryable || attempt >= retries) break;
      const base = lastError.code === 'RATE_LIMIT' ? 5_000 : 1_500;
      const jitter = Math.floor(Math.random() * 350);
      await sleep(Math.max(Number(lastError.retryAfterMs || 0), base * (attempt + 1)) + jitter);
    }
  }
  throw lastError || new FootballApiError('API-Football falló', { path });
}

function resetFootballApiLimiterForTests() {
  localNextSlot = 0;
  warnedRedisFallback = false;
}

async function closeFootballApiClient() {
  if (!redisClient) return;
  const client = redisClient;
  redisClient = null;
  try { await client.quit(); } catch { try { client.disconnect(); } catch {} }
}

module.exports = {
  FootballApiError,
  footballApiRequest,
  reserveFootballApiSlot,
  payloadQuality,
  responseSize,
  footballApiPath,
  apiErrorText,
  RATE_PER_MINUTE,
  SLOT_MS,
  FALLBACK_RATE_PER_MINUTE,
  FALLBACK_SLOT_MS,
  resetFootballApiLimiterForTests,
  closeFootballApiClient,
};
