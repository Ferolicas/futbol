import { pgPool } from './db.js';
import { freeAnalysis } from './free-access.js';
import { marketLabel } from './market-labels.js';

// Claves = valor real de prediction_runs.sport. El modelo a veces escribe
// "american-football", "nfl"… → normalizeSport lo resuelve (antes
// "american-football" nunca coincidía y fútbol americano salía vacío).
const SPORT_TABLES = {
  football: 'match_analysis',
  baseball: 'baseball_match_analysis',
  basketball: 'basketball_match_analysis',
  american_football: 'american_football_match_analysis',
};
const SPORT_ALIASES = {
  futbol: 'football', soccer: 'football', beisbol: 'baseball', mlb: 'baseball', baloncesto: 'basketball', basket: 'basketball',
  nba: 'basketball', 'american-football': 'american_football', 'futbol-americano': 'american_football', 'futbol americano': 'american_football', nfl: 'american_football',
};
export function normalizeSport(value) {
  const key = foldText(value).trim();
  if (!key) return null;
  if (SPORT_TABLES[key]) return key;
  return SPORT_ALIASES[key] || SPORT_ALIASES[key.replace(/_/g, '-')] || 'invalid';
}

const SPORT_DASHBOARD_PATH = {
  football: (id) => `/dashboard/analisis/${id}`,
  baseball: (id) => `/dashboard/baseball/analisis/${id}`,
  basketball: (id) => `/dashboard/baloncesto/analisis/${id}`,
  american_football: (id) => `/dashboard/futbol-americano/analisis/${id}`,
};

// Enlaces a funciones que YA existen en el dashboard. El asistente nunca
// ejecuta la acción (no cambia contraseñas ni nada): solo devuelve el enlace
// real para que el chat lo ofrezca como botón — lo que pase de ahí en
// adelante lo maneja el endpoint/modal existente, no el asistente.
const APP_ACTION_LINKS = {
  'change-password': { url: '/dashboard?action=change-password', label: 'Cambiar contraseña' },
};

function foldText(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ── Fechas en la zona horaria del usuario ────────────────────────────────
// "hoy", "ayer" y "mañana" se resuelven en SU zona (Colombia no es UTC):
// el partido de las 20:00 de Bogotá es "hoy" aunque en UTC ya sea mañana.
export function safeTimeZone(value) {
  try { if (value) { new Intl.DateTimeFormat('es', { timeZone: String(value) }); return String(value); } } catch {}
  return 'America/Bogota';
}
export function localDate(timeZone, offsetDays = 0, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const date = new Date(`${parts}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}
const RELATIVE_DAYS = { hoy: 0, today: 0, ayer: -1, yesterday: -1, anteayer: -2, manana: 1, tomorrow: 1, 'pasado manana': 2 };
export function resolveDate(value, timeZone) {
  if (value == null || value === '') return null;
  const text = foldText(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (text in RELATIVE_DAYS) return localDate(timeZone, RELATIVE_DAYS[text]);
  return null;
}
const kickoffLabel = (kickoff, timeZone) => {
  if (!kickoff) return null;
  const date = new Date(kickoff);
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat('es', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
};
// Próximo = aún no empezó. Es lo único útil cuando alguien pregunta "qué hay hoy".
const timingOf = (kickoff, now = Date.now()) => {
  const time = new Date(kickoff).getTime();
  if (!Number.isFinite(time)) return 'desconocido';
  return time > now ? 'proximo' : 'ya_empezo';
};

// ── Búsqueda de equipos tolerante ────────────────────────────────────────
// "cali", "deportivo cali", "atlanta", "medellin" (sin tilde): cada palabra
// debe aparecer en local+visitante+liga, en cualquier orden.
const TEAM_STOPWORDS = new Set(['vs', 'v', 'contra', 'de', 'del', 'el', 'la', 'los', 'las', 'y', 'partido', 'juego', 'equipo', 'e']);
export function teamSearchTerms(text) {
  return foldText(text).split(/[^a-z0-9]+/).filter((word) => word && !TEAM_STOPWORDS.has(word)).slice(0, 6);
}
const matchesTerms = (haystack, terms) => {
  const folded = foldText(haystack);
  return terms.every((term) => folded.includes(term));
};

// Catálogo de partidos analizados de los 4 deportes con nombre de equipos:
// prediction_runs no siempre guarda homeTeam/awayTeam en metadata.
const catalogSql = (from, to) => {
  const range = (table) => `FROM ${table} WHERE (${from}::date IS NULL OR date BETWEEN ${from}::date - 1 AND ${to}::date + 1)`;
  return `
  SELECT 'football' AS sport, fixture_id::text AS fixture_id,
    CASE WHEN analysis->>'kickoff' ~ '^\\d{4}-' THEN (analysis->>'kickoff')::timestamptz END AS kickoff,
    analysis->>'league' AS league, analysis->>'homeTeam' AS home_team, analysis->>'awayTeam' AS away_team,
    analysis->'status'->>'short' AS status, date
  ${range('match_analysis')}
  UNION ALL SELECT 'baseball', fixture_id::text, start_time, league_name, home_team, away_team, status, date ${range('baseball_match_analysis')}
  UNION ALL SELECT 'basketball', fixture_id::text, start_time, league_name, home_team, away_team, status, date ${range('basketball_match_analysis')}
  UNION ALL SELECT 'american_football', fixture_id::text, start_time, league_name, home_team, away_team, status, date ${range('american_football_match_analysis')}`;
};

const describeMatch = (row, timeZone) => ({
  sport: row.sport,
  fixtureId: String(row.fixture_id),
  match: `${row.home_team || 'Local'} vs ${row.away_team || 'Visitante'}`,
  league: row.league || null,
  kickoff: kickoffLabel(row.kickoff, timeZone),
  timing: timingOf(row.kickoff),
  matchUrl: SPORT_DASHBOARD_PATH[row.sport]?.(row.fixture_id) || null,
});

const TIMINGS = new Set(['upcoming', 'started', 'all']);
// "Solo próximos" es la regla SOLO para pedidos generales de HOY sin equipo
// ("qué opciones hay hoy", "lo mejor de hoy"). Con un equipo, o con otra
// fecha ("ayer", "el sábado"), se devuelve todo: "próximos de ayer" no existe.
const resolveTiming = ({ timing, day, hasTeam, tz }) => {
  if (TIMINGS.has(timing)) return timing;
  if (hasTeam) return 'all';
  return !day || day === localDate(tz) ? 'upcoming' : 'all';
};
// Equipo sin fecha: se busca en una ventana alrededor de hoy (7 días atrás, 3 adelante).
const dateWindow = (day, hasTeam, tz) => (day ? [day, day] : hasTeam ? [localDate(tz, -7), localDate(tz, 3)] : [localDate(tz), localDate(tz)]);
const timingFilter = (timing) => (row) => timing === 'all' || (timing === 'upcoming' ? timingOf(row.kickoff) === 'proximo' : timingOf(row.kickoff) === 'ya_empezo');

/** Busca partidos por nombre parcial de equipo/liga y fecha. Devuelve candidatos. */
export async function searchExistingMatches({ query = '', team = null, date = null, sport = null, timing = null, limit = 10, timeZone }, pool = pgPool) {
  const tz = safeTimeZone(timeZone);
  const day = resolveDate(date, tz);
  const normalizedSport = normalizeSport(sport);
  if (normalizedSport === 'invalid') return { error: 'Deporte inválido' };
  const terms = teamSearchTerms(team || query);
  if (!terms.length && !day) return { error: 'Indica al menos un equipo, liga o fecha.' };
  const when = resolveTiming({ timing, day, hasTeam: terms.length > 0, tz });
  const { rows } = await pool.query(
    `SELECT * FROM (${catalogSql('$1', '$1')}) catalog
     WHERE ($2::text IS NULL OR sport = $2)
       AND ($1::date IS NULL OR (kickoff AT TIME ZONE $3)::date = $1::date)
     ORDER BY kickoff DESC NULLS LAST LIMIT 2000`,
    [day, normalizedSport, tz],
  );
  const found = rows
    .filter((row) => !terms.length || matchesTerms(`${row.home_team} ${row.away_team} ${row.league} ${row.fixture_id}`, terms))
    .filter(timingFilter(when));
  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 10));
  return {
    date: day, timing: when, terms, total: found.length,
    matches: found.slice(0, safeLimit).map((row) => describeMatch(row, tz)),
    note: found.length > 1 && terms.length ? 'Hay varios partidos que coinciden: si el usuario habla de uno solo, preguntale cuál (listando estos).' : undefined,
  };
}

// Solo lo que el modelo necesita para responder: el objeto `output` completo
// (validaciones, calibración…) pesa ~1 KB por mercado y desbordaba el límite
// de tokens de Groq (413 con 18k tokens).
// Algunos outputs (motor empírico) no guardan `name`: se traduce la clave del
// mercado con la misma tabla que usa la web.
const compactPick = (output = {}, probabilityRaw, marketKey = null, teams = {}) => ({
  name: output.name || output.pick || (marketKey ? marketLabel(marketKey, teams) : null),
  market: output.marketLabel || output.market || null,
  // Mismo tope visible del 95% que usa toda la interfaz.
  probability: Math.min(95, Math.round(Number(probabilityRaw ?? output.rawProbability ?? output.prob_raw) * 10000) / 100),
  odd: output.odd ?? null,
  bookmaker: output.bookmaker ?? null,
});

const validFixture = (sport, fixtureId) => SPORT_TABLES[sport] && /^[\w:-]{1,64}$/.test(String(fixtureId || ''));

export async function getExistingPrediction({ sport, fixtureId, paidAccess }, pool = pgPool) {
  const normalizedSport = normalizeSport(sport);
  if (!validFixture(normalizedSport, fixtureId)) return { error: 'Identificador o deporte inválido' };
  const { rows } = await pool.query(
    `SELECT r.sport,r.fixture_id,r.kickoff,r.predicted_at,r.model_version,o.market_key,o.output,o.probability_raw,
       r.metadata->>'homeTeam' AS home_team,r.metadata->>'awayTeam' AS away_team,
       p.status AS seal_status,p.public_id,b.tsa_time
     FROM prediction_runs r JOIN prediction_market_outputs o ON o.run_id=r.id AND o.is_recommendation=TRUE
     LEFT JOIN prediction_seal_proofs p ON p.market_output_id=o.id
     LEFT JOIN prediction_seal_batches b ON b.id=p.batch_id
     WHERE r.sport=$1 AND r.fixture_id=$2
     ORDER BY r.predicted_at DESC,o.probability_raw DESC LIMIT 80`,
    [normalizedSport, String(fixtureId)],
  );
  if (!rows.length) return { exists: false, message: 'No existe un pronóstico guardado para ese partido.' };
  const latest = rows[0].predicted_at;
  const latestRows = rows.filter((row) => String(row.predicted_at) === String(latest));
  const recommendations = latestRows.map((row) => ({
    ...compactPick(row.output, row.probability_raw, row.market_key, { home: row.home_team || 'Local', away: row.away_team || 'Visitante' }),
    ...(row.seal_status === 'sealed' ? { seal: { status: 'sealed', publicId: row.public_id, sealedAt: row.tsa_time } } : {}),
  }));
  const matchUrl = SPORT_DASHBOARD_PATH[normalizedSport]?.(fixtureId) || null;
  const timing = timingOf(rows[0].kickoff);
  if (!paidAccess) {
    const preview = freeAnalysis({ combinada: { selectable: latestRows.map((row) => row.output) } }, normalizedSport)?.freePreview || null;
    return { exists: true, sport: normalizedSport, fixtureId: String(fixtureId), kickoff: rows[0].kickoff, timing, access: 'free', freePreview: preview, matchUrl };
  }
  return { exists: true, sport: normalizedSport, fixtureId: String(fixtureId), kickoff: rows[0].kickoff, timing,
    predictedAt: latest, modelVersion: rows[0].model_version, recommendations, matchUrl };
}

// A diferencia de getExistingPrediction (solo is_recommendation=TRUE), esto
// trae TODO mercado calculado exista o no cuota/recomendación — la misma
// "frecuencia calculada" que se ve en /dashboard/analisis. Es dato
// estadístico informativo: nunca se etiqueta como recomendación, y solo con
// plan pago (mismo criterio que el resto del contenido premium).
export async function getCalculatedFrequency({ sport, fixtureId, paidAccess }, pool = pgPool) {
  const normalizedSport = normalizeSport(sport);
  if (!validFixture(normalizedSport, fixtureId)) return { error: 'Identificador o deporte inválido' };
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
    probability: row.probability_raw == null ? null : Math.min(95, Math.round(Number(row.probability_raw) * 10000) / 100),
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

// Consulta GENERAL sobre TODO lo publicado de una fecha: por deporte, equipo
// (nombre parcial), probabilidad mínima, palabras del mercado y momento
// (próximos / ya empezados / todos). El texto de mercado se parte en
// palabras y CADA una debe aparecer en el nombre, sin importar acentos ni
// orden: "más de 2.5 goles" encuentra "Total partido — Goles — Más de 2.5".
const MARKET_STOPWORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'en', 'y', 'o', 'a', 'para', 'hoy', 'que', 'con', 'un', 'una', 'partido', 'partidos', 'opciones', 'opcion', 'cual', 'cuales', 'hay', 'dame', 'existen', 'tiene', 'tienen', 'recomendacion', 'recomendaciones', 'apuesta', 'apuestas', 'pick', 'picks', 'mercado', 'mercados']);
const MARKET_SYNONYMS = { over: 'mas', under: 'menos', primera: '1ª', segunda: '2ª', corner: 'corner', tarjeta: 'tarjeta', gol: 'gol' };
export function marketSearchTerms(text) {
  return foldText(text).split(/[^a-z0-9.ª+-]+/).filter((word) => word && !MARKET_STOPWORDS.has(word))
    .map((word) => MARKET_SYNONYMS[word] || word.replace(/(es|s)$/, (m, _g, i, w) => (w.length > 4 ? '' : m)))
    .slice(0, 6);
}

export async function searchRecommendations({ sport, date, team = null, minProbability = 0, marketNameLike = null, timing = null, limit = 15, paidAccess, timeZone }, pool = pgPool) {
  if (!paidAccess) return { error: 'La búsqueda de recomendaciones requiere plan pago.' };
  const tz = safeTimeZone(timeZone);
  const normalizedSport = normalizeSport(sport);
  if (normalizedSport === 'invalid') return { error: 'Deporte inválido' };
  const explicitDay = resolveDate(date, tz);
  const minProb = Math.max(0, Math.min(100, Number(minProbability) || 0)) / 100;
  const marketTerms = marketNameLike ? marketSearchTerms(String(marketNameLike).slice(0, 80)) : [];
  const teamTerms = team ? teamSearchTerms(String(team).slice(0, 80)) : [];
  const safeLimit = Math.max(1, Math.min(25, Number(limit) || 15));
  const [from, to] = dateWindow(explicitDay, teamTerms.length > 0, tz);
  const when = resolveTiming({ timing, day: explicitDay, hasTeam: teamTerms.length > 0, tz });
  const day = from === to ? from : `${from}..${to}`;
  const { rows } = await pool.query(
    `WITH catalog AS (${catalogSql('$1', '$5')})
     SELECT DISTINCT ON (r.sport, r.fixture_id, o.market_key)
       r.sport, r.fixture_id, r.kickoff,
       COALESCE(r.metadata->>'homeTeam', c.home_team) AS home_team, COALESCE(r.metadata->>'awayTeam', c.away_team) AS away_team,
       COALESCE(r.metadata->>'league', c.league) AS league, o.output, o.probability_raw, o.market_key
     FROM prediction_runs r JOIN prediction_market_outputs o ON o.run_id=r.id
     LEFT JOIN catalog c ON c.sport=r.sport AND c.fixture_id=r.fixture_id
     WHERE (r.kickoff AT TIME ZONE $4)::date BETWEEN $1::date AND $5::date AND ($2::text IS NULL OR r.sport=$2)
       AND o.is_recommendation=TRUE AND o.probability_raw>=$3
     ORDER BY r.sport, r.fixture_id, o.market_key, r.predicted_at DESC
     LIMIT 3000`,
    [from, normalizedSport, minProb, tz, to],
  );
  const byTeam = rows.filter((row) => !teamTerms.length || matchesTerms(`${row.home_team} ${row.away_team} ${row.league}`, teamTerms));
  const pickName = (row) => row.output?.name || row.output?.pick || marketLabel(row.market_key, { home: row.home_team || 'Local', away: row.away_team || 'Visitante' });
  const byMarket = byTeam.filter((row) => !marketTerms.length || matchesTerms(`${pickName(row)} ${row.output?.marketLabel || ''}`, marketTerms));
  const selected = byMarket.filter(timingFilter(when)).sort((l, r) => Number(r.probability_raw) - Number(l.probability_raw));
  const distinctMatches = [...new Map(byTeam.map((row) => [`${row.sport}:${row.fixture_id}`, row])).values()];
  const filter = { date: explicitDay, timing: TIMINGS.has(timing) ? timing : null, sport: normalizedSport, team, minProbability: Math.round(minProb * 100), marketNameLike };
  if (!selected.length) {
    const started = byMarket.filter(timingFilter('started')).length;
    return {
      exists: false, filter,
      searchedDates: day,
      message: `No hay recomendaciones publicadas para ${day}${when === 'upcoming' ? ' que aún no hayan empezado' : ''} con ese filtro.`,
      ...(when === 'upcoming' && started ? { alreadyStarted: started, hint: `Hay ${started} que ya empezaron o terminaron; ofrecé mostrarlas si le interesan.` } : {}),
      ...(teamTerms.length && !distinctMatches.length ? { hint: 'Ningún partido de esa fecha coincide con ese equipo. Probá search_existing_matches sin fecha para ver cuándo juega.' } : {}),
    };
  }
  return {
    exists: true, filter, searchedDates: day, timing: when, count: selected.length,
    ...(teamTerms.length && distinctMatches.length > 1 ? {
      matchesFound: distinctMatches.slice(0, 8).map((row) => describeMatch(row, tz)),
      note: 'El nombre coincide con varios partidos. Si son partidos del MISMO equipo en fechas distintas, mostrá cada uno por separado (indicando si ya se jugó). Si son equipos DISTINTOS con nombre parecido, preguntá cuál.',
    } : {}),
    recommendations: selected.slice(0, safeLimit).map((row) => ({
      ...describeMatch(row, tz),
      ...compactPick(row.output, row.probability_raw, row.market_key, { home: row.home_team || 'Local', away: row.away_team || 'Visitante' }),
    })),
  };
}

const DATE_DESCRIPTION = 'YYYY-MM-DD, o "hoy", "ayer", "mañana" (zona horaria del usuario). Ponela SOLO si el usuario nombró un día. Sin fecha: hoy, o si hay team, los últimos 7 días y los próximos 3.';
const TIMING_DESCRIPTION = 'Normalmente omitir (null): el servidor aplica la regla — hoy sin equipo = solo próximos; con equipo u otra fecha (ayer, el sábado) = todo. Usá "all" si pregunta en pasado por hoy ("cuáles fueron las de hoy", "cómo quedaron"); "started" si pide solo los ya jugados.';

export const CF_ASSISTANT_TOOLS = [{
  type: 'function', function: {
    name: 'search_existing_matches',
    description: 'Encuentra partidos por nombre PARCIAL de equipo o liga (ej. "cali", "atlanta", "medellin") y/o fecha. Úsala para identificar a qué partido se refiere el usuario cuando nombra un solo equipo. Si devuelve varios, preguntale al usuario cuál es.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      team: { type: 'string', description: 'Nombre parcial de equipo o liga, tal como lo escribió el usuario' },
      date: { type: ['string', 'null'], description: 'Opcional. ' + DATE_DESCRIPTION },
      sport: { type: ['string', 'null'], enum: [...Object.keys(SPORT_TABLES), null] },
      timing: { type: ['string', 'null'], enum: ['upcoming', 'started', 'all', null], description: TIMING_DESCRIPTION },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    }, required: ['team'] },
  },
}, {
  type: 'function', function: {
    name: 'search_recommendations',
    description: 'Busca recomendaciones publicadas de una fecha, con filtros combinables: deporte, equipo (nombre parcial: "cali" encuentra Santa Fe vs Deportivo Cali), probabilidad mínima, palabras del mercado y momento (próximos/ya empezados). Es la herramienta principal para "qué hay hoy", "cuáles de más de 80%", "las del cali de ayer", etc. Si te piden varios criterios de mercado distintos a la vez, llamala una vez por criterio.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      sport: { type: ['string', 'null'], enum: [...Object.keys(SPORT_TABLES), null], description: 'Omitir para todos los deportes' },
      date: { type: ['string', 'null'], description: DATE_DESCRIPTION },
      team: { type: ['string', 'null'], description: 'Nombre parcial de un equipo o liga. null si no se filtra por equipo.' },
      minProbability: { type: 'number', minimum: 0, maximum: 100, description: 'Ej. 80 para "más del 80%". 0 si no hay filtro.' },
      marketNameLike: { type: ['string', 'null'], description: 'Palabras clave del mercado, ej. "más 2.5 goles", "córners", "1ª parte goles". null si no hay filtro.' },
      timing: { type: ['string', 'null'], enum: ['upcoming', 'started', 'all', null], description: TIMING_DESCRIPTION },
      limit: { type: 'integer', minimum: 1, maximum: 25 },
    }, required: [] },
  },
}, {
  type: 'function', function: {
    name: 'get_existing_prediction',
    description: 'Recomendaciones ya guardadas de UN partido (por fixtureId, que sale de search_existing_matches o search_recommendations) y el enlace a su análisis completo.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      sport: { type: 'string', enum: Object.keys(SPORT_TABLES) },
      fixtureId: { type: 'string' },
    }, required: ['sport', 'fixtureId'] },
  },
}, {
  type: 'function', function: {
    name: 'get_calculated_frequency',
    description: 'TODAS las frecuencias calculadas de UN partido (incluidas las que no llegan a recomendación). Úsala para una línea o número puntual que no está entre sus recomendaciones. type="dato_estadistico" nunca se presenta como recomendación.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      sport: { type: 'string', enum: Object.keys(SPORT_TABLES) },
      fixtureId: { type: 'string' },
    }, required: ['sport', 'fixtureId'] },
  },
}, {
  type: 'function', function: {
    name: 'get_app_action_link',
    description: 'Enlace real de una función del dashboard (ej. cambiar contraseña) para ofrecerla en el chat. Nunca ejecuta la acción.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: Object.keys(APP_ACTION_LINKS) },
    }, required: ['action'] },
  },
}];

export async function executeAssistantTool(name, args, context) {
  const shared = { timeZone: context.timeZone };
  if (name === 'search_existing_matches') return searchExistingMatches({ ...args, ...shared });
  if (name === 'get_existing_prediction') return getExistingPrediction({ ...args, paidAccess: context.paidAccess });
  if (name === 'get_calculated_frequency') return getCalculatedFrequency({ ...args, paidAccess: context.paidAccess });
  if (name === 'search_recommendations') return searchRecommendations({ ...args, ...shared, paidAccess: context.paidAccess });
  if (name === 'get_app_action_link') return getAppActionLink(args);
  return { error: 'Herramienta no permitida' };
}
