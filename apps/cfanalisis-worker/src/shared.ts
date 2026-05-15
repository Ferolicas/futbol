// @ts-nocheck
/**
 * Shim that re-exports lib/* symbols via dynamic imports.
 *
 * Why this exists:
 *   The root package.json declares no `"type": "module"`, so Node treats
 *   lib/*.js as CommonJS — but the files use ESM syntax. Static `import …
 *   from '../../../lib/X.js'` therefore fails at parse time. Dynamic
 *   `await import()` triggers Node's syntax auto-detection (Node 22+) and
 *   loads the files as ESM transparently.
 *
 *   We could add `"type": "module"` to a `lib/package.json` to make this
 *   explicit, but that flips Next.js into strict ESM resolution and breaks
 *   the build for routes whose lib imports omit `.js` extensions
 *   (notably /api/auth/[...nextauth] via lib/auth.js → './sanity').
 *
 *   This shim isolates the dynamic-import dance to a single file. All
 *   workers import named symbols from here as if it were a normal module.
 */

const [
  _redis,
  _apiFootball,
  _apiBaseball,
  _supabase,
  _supabaseCache,
  _sanityCache,
  _webpush,
  _leagues,
  _calculations,
  _combinada,
  _baseballModel,
  _baseballCalibration,
  _oddsApi,
  _db,
] = await Promise.all([
  import('../../../lib/redis.js'),
  import('../../../lib/api-football.js'),
  import('../../../lib/api-baseball.js'),
  import('../../../lib/supabase.js'),
  import('../../../lib/supabase-cache.js'),
  import('../../../lib/sanity-cache.js'),
  import('../../../lib/webpush.js'),
  import('../../../lib/leagues.js'),
  import('../../../lib/calculations.js'),
  import('../../../lib/combinada.js'),
  import('../../../lib/baseball-model.js'),
  import('../../../lib/baseball-calibration.js'),
  import('../../../lib/odds-api.js'),
  import('../../../lib/db.js'),
]);

// triggerEvent ahora viene del wsManager local del worker (WebSocket nativo)
// en vez de Pusher. Mismo contrato: triggerEvent(channel, event, data).
import { triggerEvent as wsTriggerEvent } from './ws/wsManager.js';

// lib/redis.js
export const redisGet = _redis.redisGet;
export const redisSet = _redis.redisSet;
export const redisIncr = _redis.redisIncr;
export const redisDel = _redis.redisDel;
export const KEYS = _redis.KEYS;
export const TTL = _redis.TTL;

// lib/api-football.js
export const getFixtures = _apiFootball.getFixtures;
export const analyzeMatch = _apiFootball.analyzeMatch;
export const getQuota = _apiFootball.getQuota;

// lib/api-baseball.js
export const getBaseballFixturesByDate = _apiBaseball.getBaseballFixturesByDate;
export const getBaseballOddsByGame = _apiBaseball.getBaseballOddsByGame;
export const getBaseballTeamStats = _apiBaseball.getBaseballTeamStats;
export const getBaseballH2H = _apiBaseball.getBaseballH2H;
export const getBaseballQuota = _apiBaseball.getBaseballQuota;
export const getBaseballLiveGames = _apiBaseball.getBaseballLiveGames;

// lib/supabase.js
export const supabaseAdmin = _supabase.supabaseAdmin;

// lib/supabase-cache.js
export const saveMatchSchedule = _supabaseCache.saveMatchSchedule;
export const getMatchSchedule = _supabaseCache.getMatchSchedule;

// lib/sanity-cache.js (renamed but Redis+Supabase under the hood)
export const cacheFixtures = _sanityCache.cacheFixtures;
export const cacheAnalysis = _sanityCache.cacheAnalysis;
export const getCachedAnalysis = _sanityCache.getCachedAnalysis;
export const getCachedFixturesRaw = _sanityCache.getCachedFixturesRaw;
export const getAnalyzedFixtureIds = _sanityCache.getAnalyzedFixtureIds;
export const incrementApiCallCount = _sanityCache.incrementApiCallCount;

// triggerEvent — antes Pusher, ahora WebSocket nativo (mismo contrato).
export const triggerEvent = wsTriggerEvent;

// lib/webpush.js
export const sendPushNotification = _webpush.sendPushNotification;

// lib/leagues.js
export const ALL_LEAGUE_IDS = _leagues.ALL_LEAGUE_IDS;

// lib/calculations.js
export const computeAllProbabilities = _calculations.computeAllProbabilities;

// lib/combinada.js
export const buildCombinada = _combinada.buildCombinada;

// lib/baseball-model.js
export const computeBaseballProbabilities = _baseballModel.computeBaseballProbabilities;
export const buildBaseballCombinada = _baseballModel.buildBaseballCombinada;
export const scoreBaseballDataQuality = _baseballModel.scoreBaseballDataQuality;
export const extractBestOdds = _baseballModel.extractBestOdds;

// lib/baseball-calibration.js
export const calibrateBaseballProbabilities = _baseballCalibration.calibrateBaseballProbabilities;
export const flattenProbabilitiesForStorage = _baseballCalibration.flattenProbabilitiesForStorage;

// lib/odds-api.js
export const fetchOddsForFixtures = _oddsApi.fetchOddsForFixtures;

// lib/db.js — acceso raw pg para casos que pgAdmin no cubre (RPC, raw SQL)
export const pgQuery = _db.pgQuery;
