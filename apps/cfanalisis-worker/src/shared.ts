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

// Paths pasados como variables — TypeScript NO puede seguir estos imports
// estaticamente (los resuelve Node en runtime). Esto es deliberado: con
// rutas literales, TS los incluye en el program graph y como estan fuera
// del rootDir/src/ falla con TS5055 ("would overwrite input file").
//
// Concat manual = TS solo ve `import(string)` → tipo any → cero conflicto
// de emit. Comportamiento en runtime identico al literal.
const LIB = '../../../lib/';
const SCRIPTS = '../../../scripts/';
const [
  _redis,
  _apiFootball,
  _supabase,
  _supabaseCache,
  _sanityCache,
  _webpush,
  _leagues,
  _combinada,
  _baseballModel,
  _baseballCalibration,
  _baseballFeatures,
  _baseballMl,
  _oddsApi,
  _db,
  _mlbStatsApi,
  _rawBackfill,
  _playerPhotos,
  _reenrich,
  _buildProfiles,
  _trainMeta,
  _baseRates,
  _reenrichBaseball,
  _trainBaseballMeta,
  _modelIngest,
] = await Promise.all([
  import(LIB + 'redis.js'),
  import(LIB + 'api-football.js'),
  import(LIB + 'supabase.js'),
  import(LIB + 'supabase-cache.js'),
  import(LIB + 'sanity-cache.js'),
  import(LIB + 'webpush.js'),
  import(LIB + 'leagues.js'),
  import(LIB + 'combinada.js'),
  import(LIB + 'baseball-model.js'),
  import(LIB + 'baseball-calibration.js'),
  import(LIB + 'baseball-features.js'),
  import(LIB + 'baseball-ml.js'),
  import(LIB + 'odds-api.js'),
  import(LIB + 'db.js'),
  import(LIB + 'mlb-stats-api.js'),
  import(LIB + 'raw-backfill.js'),
  import(LIB + 'player-photos.js'),
  // Scripts del pipeline de retrain — refactorizados a funciones exportadas
  // (CommonJS, con guard require.main para uso CLI). Se cargan vía import()
  // dinámico igual que los lib/*; el guard NO se dispara dentro del worker.
  import(SCRIPTS + 'reenrich-features.js'),
  import(SCRIPTS + 'build-team-profiles.js'),
  import(SCRIPTS + 'train-meta-models.js'),
  import(SCRIPTS + 'compute-market-base-rates.js'),
  import(SCRIPTS + 'reenrich-baseball.js'),
  import(SCRIPTS + 'train-baseball-meta-models.js'),
  import(LIB + 'model-ingest.js'),
]);

// triggerEvent ahora viene del wsManager local del worker (WebSocket nativo)
// en vez de Pusher. Mismo contrato: triggerEvent(channel, event, data).
import { triggerEvent as wsTriggerEvent } from './ws/wsManager.js';

// lib/redis.js
export const redisGet = _redis.redisGet;
export const redisSet = _redis.redisSet;
export const redisIncr = _redis.redisIncr;
export const redisDel = _redis.redisDel;
export const redisListPush = _redis.redisListPush;
export const redisListRange = _redis.redisListRange;
export const KEYS = _redis.KEYS;
export const TTL = _redis.TTL;

// lib/api-football.js
export const getFixtures = _apiFootball.getFixtures;
export const analyzeMatch = _apiFootball.analyzeMatch;
export const getQuota = _apiFootball.getQuota;

// (api-baseball.js purgado — baseball es 100% MLB Stats API + The Odds API,
//  ver lib/mlb-stats-api.js y lib/odds-api.js)

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

// lib/raw-backfill.js (captura cruda total, Camino B)
export const runRawBackfill = _rawBackfill.runRawBackfill;
// lib/player-photos.js — almacén/warm de fotos de jugadores
export const warmPlayerPhotos = _playerPhotos.warmPlayerPhotos;
export const getPlayerPhoto = _playerPhotos.getPlayerPhoto;
// Captura focalizada por fixture (cron nocturno de retrain).
export const captureFinalizedFixturesRaw = _rawBackfill.captureFinalizedFixturesRaw;

// lib/model-ingest.js (FASE 2E) — ingesta crudo → schema `model` (compartida con 2B).
export const ingestFixtures = _modelIngest.ingestFixtures;
export const ingestFixtureObjects = _modelIngest.ingestFixtureObjects;

// scripts/* del pipeline de retrain (CommonJS → import() dinámico).
export const reenrichFeatures = _reenrich.reenrichFeatures;
export const buildTeamProfiles = _buildProfiles.buildTeamProfiles;
export const trainMetaModels = _trainMeta.trainMetaModels;
// scripts/compute-market-base-rates.js — prior del shrink de calibración. Lo
// re-corre el cron nocturno (futbol-retrain) tras entrenar, con el pgPool.
export const computeMarketBaseRates = _baseRates.computeMarketBaseRates;

// scripts/reenrich-baseball.js + scripts/train-baseball-meta-models.js —
// se invocan desde el cron baseball-retrain. Mismo guard CLI que los de fútbol.
export const reenrichBaseball         = _reenrichBaseball.reenrichBaseball;
export const trainBaseballMetaModels  = _trainBaseballMeta.trainBaseballMetaModels;

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

// lib/baseball-features.js — feature engineering point-in-time compartido
// entre el cron retrain (reenrich + train) y el runtime de analyze.
export const BASEBALL_FEATURE_ORDER         = _baseballFeatures.BASEBALL_FEATURE_ORDER;
export const buildBaseballFeatureIndex      = _baseballFeatures.buildBaseballFeatureIndex;
export const computeBaseballFeaturesForGame = _baseballFeatures.computeBaseballFeaturesForGame;

// lib/baseball-ml.js — runtime de inferencia ML (carga modelos activos +
// aplica overrides sobre los 3 mercados entrenados).
export const loadActiveBaseballModels = _baseballMl.loadActiveBaseballModels;
export const applyMlOverrides         = _baseballMl.applyMlOverrides;

// lib/odds-api.js
export const fetchOddsForFixtures = _oddsApi.fetchOddsForFixtures;
export const fetchMlbOddsByDate = _oddsApi.fetchMlbOddsByDate;
export const matchMlbOdds = _oddsApi.matchMlbOdds;

// lib/mlb-stats-api.js — fuente oficial MLB/MiLB (statsapi.mlb.com)
export const getMlbScheduleByDate = _mlbStatsApi.getMlbScheduleByDate;
export const getMlbPitcherMatchup = _mlbStatsApi.getMlbPitcherMatchup;
export const getMlbTeamSeasonStats = _mlbStatsApi.getMlbTeamSeasonStats;
export const toModelTeamStats = _mlbStatsApi.toModelTeamStats;
export const getMlbLiveGame = _mlbStatsApi.getMlbLiveGame;
export const getMlbResultsByDate = _mlbStatsApi.getMlbResultsByDate;
export const MLB_SPORT_IDS = _mlbStatsApi.MLB_SPORT_IDS;
// Player props (game logs MLB). Sustituye al extractor legacy de baseball-model
// (que devolvía null porque api-baseball no tiene jugadores).
export const extractBaseballPlayerHighlights = _mlbStatsApi.extractBaseballPlayerHighlights;
export const getMlbPitcherGameLog = _mlbStatsApi.getMlbPitcherGameLog;
export const getMlbBatterGameLog = _mlbStatsApi.getMlbBatterGameLog;
export const getMlbGameLineup = _mlbStatsApi.getMlbGameLineup;

// lib/db.js — acceso raw pg para casos que pgAdmin no cubre (RPC, raw SQL)
export const pgQuery = _db.pgQuery;
export const pgPool  = _db.pgPool;   // Pool singleton (requerido por lib/baseball-features.js y baseball-ml.js)

// ────────────────────────────────────────────────────────────────────────────
// FECHAS DE LOS JOBS — TODO en hora de Bogotá (America/Bogota).
//
// La app es para usuarios de Colombia. Una "jornada" es un día COMPLETO de
// Bogotá: 00:00–23:59 America/Bogota. `getFixtures(date)` ya consulta la API
// con `timezone=America/Bogota` (lib/api-football.js), así que `date` SIEMPRE
// es un día calendario de Bogotá. El frontend luego muestra a cada usuario los
// partidos según su propia zona horaria, pero el análisis canónico es por día
// de Bogotá.

// Fecha (YYYY-MM-DD) de HOY en America/Bogota.
export function bogotaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(now);
}

// Hora (0-23) actual en America/Bogota.
function bogotaHour(now: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Bogota', hour: '2-digit', hour12: false }).format(now),
  ) % 24;
}

// Suma `days` a una fecha calendario 'YYYY-MM-DD' (aritmética de calendario
// pura, sin zona horaria — la fecha ya representa un día de Bogotá).
function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().split('T')[0] as string;
}

// JORNADA OBJETIVO del batch diario (fixtures + daily + analyze-batch).
//
// BUG QUE RESUELVE (confirmado 2026-05-26): `fixtures.js` cacheaba el día
// SIGUIENTE de Bogotá (lo correcto) mientras `daily.js` calculaba el día ACTUAL
// de Bogotá → a la hora del cron (02:10 Madrid = 19:10 Bogotá del día anterior)
// diferían en 1 día. `daily` leía `dailyBatch:{díaActual}` ya completado del
// ciclo anterior, retornaba "already completed" y NUNCA encolaba analyze-batch
// para el día que `fixtures` acababa de cachear. El día nunca se analizaba.
//
// El cron dispara a las 02:10 Europe/Madrid, que en Bogotá son ~19:10 del día
// ANTERIOR. A esa hora el día de Bogotá en curso ya casi terminó (sus partidos
// ya se jugaron), así que la jornada útil a preparar/analizar es la que está a
// punto de empezar: el SIGUIENTE día de Bogotá (la próxima medianoche Bogotá).
// Por eso, si en Bogotá ya pasó el mediodía → preparamos MAÑANA; si es la
// mañana (única ventana de una posible llamada manual sin fecha) → HOY.
//
// Los caminos manuales (botón "re-analizar", auto-trigger del frontend) NO usan
// esta función: pasan una fecha explícita (la del usuario / la del día que se
// está viendo). Esta solo gobierna el cron automático de las 02:10 Madrid.
export function cronTargetDate(now: Date = new Date()): string {
  const today = bogotaToday(now);
  return bogotaHour(now) >= 12 ? addDays(today, 1) : today;
}
