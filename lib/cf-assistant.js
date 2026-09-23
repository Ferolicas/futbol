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
    ...compactPick(row.output),
    ...(row.seal_status === 'sealed' ? { seal: { status: 'sealed', publicId: row.public_id, sealedAt: row.tsa_time } } : {}),
  }));
  const matchUrl = SPORT_DASHBOARD_PATH[normalizedSport]?.(fixtureId) || null;
  if (!paidAccess) {
    const fullOutputs = rows.filter((row) => String(row.predicted_at) === String(latest)).map((row) => row.output);
    const preview = freeAnalysis({ combinada: { selectable: fullOutputs } }, normalizedSport)?.freePreview || null;
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
     ORDER BY r.predicted_at DESC,o.probability_raw DESC LIMIT 60`,
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
// Consulta GENERAL sobre TODO lo publicado (todos los partidos de una
// fecha, opcionalmente un deporte) — no una pregunta fija. Filtra por
// probabilidad mínima y/o por texto libre contra el nombre real de cada
// mercado (ej. "más de 2.5 goles", "córners", "primera parte"), que ya
// viene en español desde market-labels.js — el asistente no necesita
// conocer las claves internas de mercado. Para pedidos con VARIOS criterios
// a la vez ("más de 2.5 goles Y más de 6.5 córners Y gol en 1ª parte"), el
// modelo debe llamar esta herramienta UNA VEZ POR CRITERIO en la misma
// respuesta (tool_calls múltiples), no intentar meterlos en una sola llamada.
// El texto libre se parte en palabras y CADA una debe aparecer en el nombre
// del mercado, sin importar acentos ni orden: "más de 2.5 goles" encuentra
// "Total partido — Goles — Más de 2.5" (antes se buscaba la frase entera y
// nunca coincidía). Sinónimos mínimos para cómo la gente pregunta.
const MARKET_STOPWORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'en', 'y', 'o', 'a', 'para', 'hoy', 'que', 'con', 'un', 'una', 'partido', 'partidos', 'opciones', 'opcion', 'cual', 'cuales', 'hay', 'dame', 'existen', 'tiene', 'tienen', 'recomendacion', 'recomendaciones', 'apuesta', 'apuestas', 'pick', 'picks', 'mercado', 'mercados']);
const MARKET_SYNONYMS = { over: 'mas', under: 'menos', primera: '1ª', segunda: '2ª', corner: 'corner', tarjeta: 'tarjeta', gol: 'gol' };
const foldText = (value) => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
export function marketSearchTerms(text) {
  return foldText(text).split(/[^a-z0-9.ª+-]+/).filter((word) => word && !MARKET_STOPWORDS.has(word))
    .map((word) => MARKET_SYNONYMS[word] || word.replace(/(es|s)$/, (m, _g, i, w) => (w.length > 4 ? '' : m)))
    .slice(0, 6);
}

// Solo lo que el modelo necesita para responder: el objeto `output` completo
// (validaciones, calibración…) pesa ~1 KB por mercado y desbordaba el límite
// de tokens de Groq (413 con 18k tokens).
const compactPick = (output = {}, probabilityRaw) => ({
  name: output.name || output.pick || null,
  market: output.marketLabel || output.market || null,
  probability: Math.round(Number(probabilityRaw ?? output.rawProbability ?? output.prob_raw) * 10000) / 100,
  odd: output.odd ?? null,
  bookmaker: output.bookmaker ?? null,
});

export async function searchRecommendations({ sport, date, minProbability = 0, marketNameLike = null, limit = 15, paidAccess }, pool = pgPool) {
  if (!paidAccess) return { error: 'La búsqueda de recomendaciones requiere plan pago.' };
  const normalizedSport = sport ? String(sport).toLowerCase() : null;
  if (normalizedSport && !SPORT_TABLES[normalizedSport]) return { error: 'Deporte inválido' };
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : new Date().toISOString().slice(0, 10);
  const minProb = Math.max(0, Math.min(100, Number(minProbability) || 0)) / 100;
  const terms = marketNameLike ? marketSearchTerms(String(marketNameLike).slice(0, 80)) : [];
  const safeLimit = Math.max(1, Math.min(25, Number(limit) || 15));
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (r.sport, r.fixture_id, o.market_key)
         r.sport, r.fixture_id, r.kickoff,
         r.metadata->>'homeTeam' AS home_team, r.metadata->>'awayTeam' AS away_team, r.metadata->>'league' AS league,
         o.output, o.probability_raw
       FROM prediction_runs r JOIN prediction_market_outputs o ON o.run_id=r.id
       WHERE r.kickoff::date=$1 AND ($2::text IS NULL OR r.sport=$2)
         AND o.is_recommendation=TRUE AND o.probability_raw>=$3
         AND NOT EXISTS (
           SELECT 1 FROM unnest($4::text[]) AS term
           WHERE translate(lower(concat_ws(' ', o.output->>'name', o.output->>'pick', o.output->>'marketLabel')), 'áéíóúüñ', 'aeiouun') NOT LIKE '%'||term||'%'
         )
       ORDER BY r.sport, r.fixture_id, o.market_key, r.predicted_at DESC
     ) latest
     ORDER BY probability_raw DESC LIMIT $5`,
    [safeDate, normalizedSport, minProb, terms, safeLimit],
  );
  if (!rows.length) {
    return {
      exists: false, date: safeDate, filter: { minProbability: Math.round(minProb * 100), marketNameLike, terms },
      message: `No hay recomendaciones publicadas para ${safeDate}${normalizedSport ? ` en ${normalizedSport}` : ''} que cumplan ese filtro.`,
    };
  }
  return {
    exists: true, date: safeDate, count: rows.length,
    recommendations: rows.map((row) => ({
      sport: row.sport, fixtureId: row.fixture_id, kickoff: row.kickoff,
      match: `${row.home_team || 'Local'} vs ${row.away_team || 'Visitante'}`, league: row.league,
      matchUrl: SPORT_DASHBOARD_PATH[row.sport]?.(row.fixture_id) || null,
      ...compactPick(row.output, row.probability_raw),
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
    name: 'search_recommendations',
    description: 'Busca en TODO lo publicado de una fecha (todos los partidos, opcionalmente un solo deporte): por probabilidad mínima y/o por texto libre contra el nombre del mercado (ej. "goles", "más de 2.5", "córners", "primera parte" — no hace falta la clave interna, el nombre ya está en español). Úsala para CUALQUIER pregunta sobre varios partidos a la vez, no solo probabilidad — nunca respondas "no hay nada" sin haberla llamado, y nunca intentes armarlo llamando get_existing_prediction partido por partido (no sabés de antemano los fixtureId). Si te piden VARIOS criterios distintos a la vez, llamala una vez POR CADA criterio en la misma respuesta.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      sport: { type: ['string', 'null'], enum: [...Object.keys(SPORT_TABLES), null], description: 'Omitir para todos los deportes' },
      date: { type: ['string', 'null'], description: 'YYYY-MM-DD, por defecto hoy' },
      minProbability: { type: 'number', minimum: 0, maximum: 100, description: 'Ej. 80 para "más del 80%". 0 si no hay filtro de probabilidad.' },
      marketNameLike: { type: ['string', 'null'], description: 'Palabras clave del mercado, ej. "más 2.5 goles", "menos córners", "1ª parte goles". Cada palabra debe aparecer en el nombre (sin importar orden ni acentos). null si no hay filtro de mercado.' },
      limit: { type: 'integer', minimum: 1, maximum: 25 },
    }, required: [] },
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
  if (name === 'search_recommendations') return searchRecommendations({ ...args, paidAccess: context.paidAccess });
  if (name === 'get_app_action_link') return getAppActionLink(args);
  return { error: 'Herramienta no permitida' };
}
