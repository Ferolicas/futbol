import { pgPool } from './db.js';
import { freeAnalysis } from './free-access.js';

const SPORT_TABLES = {
  football: 'match_analysis',
  baseball: 'baseball_match_analysis',
  basketball: 'basketball_match_analysis',
  'american-football': 'american_football_match_analysis',
};

const SPORT_DASHBOARD_PATH = {
  football: (id) => `/dashboard/analisis/${id}`,
  baseball: (id) => `/dashboard/baseball/analisis/${id}`,
  basketball: (id) => `/dashboard/baloncesto/analisis/${id}`,
  'american-football': (id) => `/dashboard/futbol-americano/analisis/${id}`,
};

// Enlaces a funciones que YA existen en el dashboard. El asistente nunca
// ejecuta la acción (no cambia contraseñas ni nada): solo devuelve el enlace
// real para que el chat lo ofrezca como botón — lo que pase de ahí en
// adelante lo maneja el endpoint/modal existente, no el asistente.
const APP_ACTION_LINKS = {
  'change-password': { url: '/dashboard?action=change-password', label: 'Cambiar contraseña' },
};

export async function searchExistingMatches({ query = '', date = null, limit = 12 }, pool = pgPool) {
  const text = String(query).trim().slice(0, 100);
  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 12));
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT 'football' AS sport,fixture_id::text AS fixture_id,date::text AS date,
         COALESCE(analysis->>'kickoff',date::text) AS kickoff,
         COALESCE(analysis->>'league','Fútbol') AS league,
         COALESCE(analysis->>'homeTeam','Local') AS home_team,COALESCE(analysis->>'awayTeam','Visitante') AS away_team,
         COALESCE(analysis->'status'->>'short','') AS status
       FROM match_analysis
       UNION ALL SELECT 'baseball',fixture_id::text,date::text,start_time::text,league_name,home_team,away_team,status FROM baseball_match_analysis
       UNION ALL SELECT 'basketball',fixture_id::text,date::text,start_time::text,league_name,home_team,away_team,status FROM basketball_match_analysis
       UNION ALL SELECT 'american-football',fixture_id::text,date::text,start_time::text,league_name,home_team,away_team,status FROM american_football_match_analysis
     ) catalog
     WHERE ($1::text='' OR concat_ws(' ',league,home_team,away_team,fixture_id) ILIKE '%'||$1||'%')
       AND ($2::date IS NULL OR date::date=$2::date)
     ORDER BY kickoff DESC LIMIT $3`,
    [text, date || null, safeLimit],
  );
  return rows;
}
export async function getExistingPrediction({ sport, fixtureId, paidAccess }, pool = pgPool) {
  const normalizedSport = String(sport || '').toLowerCase();
  if (!SPORT_TABLES[normalizedSport] || !/^[\w:-]{1,64}$/.test(String(fixtureId || ''))) return { error: 'Identificador o deporte inválido' };
  const { rows } = await pool.query(
    `SELECT r.sport,r.fixture_id,r.kickoff,r.predicted_at,r.model_version,o.market_key,o.output,
       p.status AS seal_status,p.public_id,b.tsa_time
     FROM prediction_runs r JOIN prediction_market_outputs o ON o.run_id=r.id AND o.is_recommendation=TRUE
     LEFT JOIN prediction_seal_proofs p ON p.market_output_id=o.id
     LEFT JOIN prediction_seal_batches b ON b.id=p.batch_id
     WHERE r.sport=$1 AND r.fixture_id=$2
     ORDER BY r.predicted_at DESC,o.market_key LIMIT 80`,
    [normalizedSport, String(fixtureId)],
  );
  if (!rows.length) return { exists: false, message: 'No existe un pronóstico guardado para ese partido.' };
  const latest = rows[0].predicted_at;
  const recommendations = rows.filter((row) => String(row.predicted_at) === String(latest)).map((row) => ({
    ...row.output,
    ...(row.seal_status === 'sealed' ? { seal: { status: 'sealed', publicId: row.public_id, sealedAt: row.tsa_time } } : {}),
  }));
  const matchUrl = SPORT_DASHBOARD_PATH[normalizedSport]?.(fixtureId) || null;
  if (!paidAccess) {
    const preview = freeAnalysis({ combinada: { selectable: recommendations } }, normalizedSport)?.freePreview || null;
    return { exists: true, sport: normalizedSport, fixtureId: String(fixtureId), kickoff: rows[0].kickoff, access: 'free', freePreview: preview, matchUrl };
  }
  return { exists: true, sport: normalizedSport, fixtureId: String(fixtureId), kickoff: rows[0].kickoff,
    predictedAt: latest, modelVersion: rows[0].model_version, recommendations, matchUrl };
}

// A diferencia de getExistingPrediction (solo is_recommendation=TRUE), esto
// trae TODO mercado calculado exista o no cuota/recomendación — la misma
// "frecuencia calculada" que se ve en /dashboard/analisis. Es dato
// estadístico informativo: nunca se etiqueta como recomendación, y solo con
// plan pago (mismo criterio que el resto del contenido premium).
export async function getCalculatedFrequency({ sport, fixtureId, paidAccess }, pool = pgPool) {
  const normalizedSport = String(sport || '').toLowerCase();
  if (!SPORT_TABLES[normalizedSport] || !/^[\w:-]{1,64}$/.test(String(fixtureId || ''))) return { error: 'Identificador o deporte inválido' };
  if (!paidAccess) return { error: 'La frecuencia calculada completa requiere plan pago. Solo la recomendación principal está disponible en el plan gratuito.' };
  const { rows } = await pool.query(
    `SELECT o.market_key,o.market_family,o.probability_raw,o.confidence,o.sample_n,
       o.offered_odd,o.bookmaker,o.is_recommendation,r.predicted_at
     FROM prediction_runs r JOIN prediction_market_outputs o ON o.run_id=r.id
     WHERE r.sport=$1 AND r.fixture_id=$2
     ORDER BY r.predicted_at DESC,o.probability_raw DESC LIMIT 200`,
    [normalizedSport, String(fixtureId)],
  );
  if (!rows.length) return { exists: false, message: 'No hay frecuencias calculadas guardadas para ese partido.' };
  const latest = rows[0].predicted_at;
  const markets = rows.filter((row) => String(row.predicted_at) === String(latest)).map((row) => ({
    marketKey: row.market_key,
    marketFamily: row.market_family,
    probability: row.probability_raw == null ? null : Math.round(Number(row.probability_raw) * 10000) / 100,
    confidence: row.confidence == null ? null : Math.round(Number(row.confidence) * 10000) / 100,
    sampleSize: row.sample_n,
    // Este campo es la única diferencia real con una recomendación: si es
    // false, el número es puramente informativo (no cumple el criterio de
    // publicación) y el asistente debe llamarlo "dato estadístico", nunca
    // "recomendación".
    type: row.is_recommendation ? 'recomendacion' : 'dato_estadistico',
  }));
  return {
    exists: true, sport: normalizedSport, fixtureId: String(fixtureId), predictedAt: latest,
    matchUrl: SPORT_DASHBOARD_PATH[normalizedSport]?.(fixtureId) || null,
    markets,
    note: 'type="dato_estadistico" es frecuencia histórica calculada, NO una recomendación de apuesta — nunca la presentes como una.',
  };
}

export function getAppActionLink({ action }) {
  const link = APP_ACTION_LINKS[String(action || '')];
  if (!link) return { error: 'No existe esa acción. Acciones disponibles: ' + Object.keys(APP_ACTION_LINKS).join(', ') };
  return { exists: true, ...link };
}

// Lista recomendaciones ACROSS todos los partidos de un día (opcionalmente de
// un solo deporte) por probabilidad mínima — a diferencia de get_existing_prediction
// (un fixtureId concreto), esto responde "dame las de más de 80% de hoy" sin que
// el asistente tenga que adivinar/enumerar partido por partido.
export async function getDailyRecommendations({ sport, date, minProbability = 0, limit = 30, paidAccess }, pool = pgPool) {
  if (!paidAccess) return { error: 'El listado de recomendaciones del día requiere plan pago.' };
  const normalizedSport = sport ? String(sport).toLowerCase() : null;
  if (normalizedSport && !SPORT_TABLES[normalizedSport]) return { error: 'Deporte inválido' };
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : new Date().toISOString().slice(0, 10);
  const minProb = Math.max(0, Math.min(100, Number(minProbability) || 0)) / 100;
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 30));
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (r.sport, r.fixture_id, o.market_key)
         r.sport, r.fixture_id, r.kickoff,
         r.metadata->>'homeTeam' AS home_team, r.metadata->>'awayTeam' AS away_team, r.metadata->>'league' AS league,
         o.output, o.probability_raw
       FROM prediction_runs r JOIN prediction_market_outputs o ON o.run_id=r.id
       WHERE r.kickoff::date=$1 AND ($2::text IS NULL OR r.sport=$2)
         AND o.is_recommendation=TRUE AND o.probability_raw>=$3
       ORDER BY r.sport, r.fixture_id, o.market_key, r.predicted_at DESC
     ) latest
     ORDER BY probability_raw DESC LIMIT $4`,
    [safeDate, normalizedSport, minProb, safeLimit],
  );
  if (!rows.length) return { exists: false, date: safeDate, message: `No hay recomendaciones que superen ${Math.round(minProb * 100)}% para ${safeDate}${normalizedSport ? ` en ${normalizedSport}` : ''}.` };
  return {
    exists: true, date: safeDate, count: rows.length,
    recommendations: rows.map((row) => ({
      sport: row.sport, fixtureId: row.fixture_id, kickoff: row.kickoff,
      homeTeam: row.home_team, awayTeam: row.away_team, league: row.league,
      probability: Math.round(Number(row.probability_raw) * 10000) / 100,
      matchUrl: SPORT_DASHBOARD_PATH[row.sport]?.(row.fixture_id) || null,
      ...row.output,
    })),
  };
}

export const CF_ASSISTANT_TOOLS = [{
  type: 'function', function: {
    name: 'search_existing_matches',
    description: 'Busca partidos que ya existen en CF Análisis por equipo, liga, ID o fecha. Solo lectura.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      query: { type: 'string', description: 'Equipo, liga o ID a buscar' },
      date: { type: ['string', 'null'], description: 'Fecha opcional YYYY-MM-DD' },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    }, required: ['query'] },
  },
}, {
  type: 'function', function: {
    name: 'get_daily_recommendations',
    description: 'Lista TODAS las recomendaciones publicadas de un día que superan una probabilidad mínima, en todos los partidos (opcionalmente de un solo deporte). Úsala para preguntas generales como "dame las recomendaciones de más de 80% de hoy" — no uses get_existing_prediction para esto, requeriría adivinar cada fixtureId uno por uno.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      sport: { type: ['string', 'null'], enum: [...Object.keys(SPORT_TABLES), null], description: 'Omitir para todos los deportes' },
      date: { type: ['string', 'null'], description: 'YYYY-MM-DD, por defecto hoy' },
      minProbability: { type: 'number', minimum: 0, maximum: 100, description: 'Ej. 80 para "más del 80%"' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    }, required: ['minProbability'] },
  },
}, {
  type: 'function', function: {
    name: 'get_existing_prediction',
    description: 'Obtiene la(s) recomendación(es) estadística(s) ya guardadas de un partido (las que sí cumplen el criterio de publicación) y el enlace a su análisis completo. Nunca calcula, modifica ni crea pronósticos.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      sport: { type: 'string', enum: Object.keys(SPORT_TABLES) },
      fixtureId: { type: 'string' },
    }, required: ['sport', 'fixtureId'] },
  },
}, {
  type: 'function', function: {
    name: 'get_calculated_frequency',
    description: 'Obtiene TODAS las frecuencias/probabilidades calculadas de un partido (goles, córners, etc.), incluidas las que NO llegan a ser recomendación. Úsala cuando te pregunten un número/probabilidad que no aparece como recomendación (ej. "cuántos goles va a haber"). Cada mercado trae type="recomendacion" o type="dato_estadistico" — un "dato_estadistico" nunca se presenta como recomendación de apuesta.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      sport: { type: 'string', enum: Object.keys(SPORT_TABLES) },
      fixtureId: { type: 'string' },
    }, required: ['sport', 'fixtureId'] },
  },
}, {
  type: 'function', function: {
    name: 'get_app_action_link',
    description: 'Da el enlace real de una función que ya existe en el dashboard (ej. cambiar contraseña), para ofrecerla como botón/enlace en el chat. Nunca ejecuta la acción — solo la ubica.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: Object.keys(APP_ACTION_LINKS) },
    }, required: ['action'] },
  },
}];

export async function executeAssistantTool(name, args, context) {
  if (name === 'search_existing_matches') return searchExistingMatches(args);
  if (name === 'get_existing_prediction') return getExistingPrediction({ ...args, paidAccess: context.paidAccess });
  if (name === 'get_calculated_frequency') return getCalculatedFrequency({ ...args, paidAccess: context.paidAccess });
  if (name === 'get_daily_recommendations') return getDailyRecommendations({ ...args, paidAccess: context.paidAccess });
  if (name === 'get_app_action_link') return getAppActionLink(args);
  return { error: 'Herramienta no permitida' };
}
