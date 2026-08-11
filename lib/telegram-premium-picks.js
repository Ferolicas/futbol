import { meetsReliability, reliabilityPercent } from './recommendation-policy.js';

// supabase.js construye el pool de Postgres al cargarse; se importa perezoso
// dentro de los builders para que las funciones puras de este módulo puedan
// usarse (y testearse) sin base de datos ni variables de entorno.
async function db() {
  const { supabaseAdmin } = await import('./supabase.js');
  return supabaseAdmin;
}

/**
 * Picks Premium de Telegram — segundo canal, reglas propias.
 *
 * A diferencia de la Apuesta del Día (lib/telegram-daily-pick.js: 3 partidos ×
 * 3 opciones, hándicap prohibido), este canal publica UNA imagen por deporte
 * con TODOS los partidos del día y TODAS sus opciones elegibles:
 *
 *   Fútbol   → solo hándicap, córners y goles; probabilidad > 90 (estricto,
 *              "por encima del 90%") y fiabilidad >= 90.
 *   Béisbol  → carreras (partido/equipo/entradas), hándicap, hits (partido y
 *              equipo), hits del bateador y ponches del lanzador; probabilidad
 *              >= 60 y fiabilidad >= 90.
 *
 * Este módulo NO toca el motor: lee los análisis ya calculados en
 * match_analysis / baseball_match_analysis, igual que hace
 * /api/cron/publish-combinada, y solo filtra su catálogo.
 */

const EPSILON = 1e-9;
const PREMATCH_BUFFER_MS = 5 * 60 * 1000;
const BETTABLE_FOOTBALL_STATUSES = new Set(['NS', 'TBD']);

export const FOOTBALL_PREMIUM_RULES = Object.freeze({
  minProbabilityExclusive: 90,
  minReliability: 90,
  groups: ['handicap', 'corners', 'goles'],
});

export const BASEBALL_PREMIUM_RULES = Object.freeze({
  minProbability: 60,
  minReliability: 90,
  groups: ['carreras', 'handicap', 'hits', 'hits-bateador', 'ponches'],
});

export const FOOTBALL_GROUP_LABELS = Object.freeze({
  handicap: 'HÁNDICAP',
  corners: 'CÓRNERS',
  goles: 'GOLES',
});

export const BASEBALL_GROUP_LABELS = Object.freeze({
  carreras: 'CARRERAS',
  handicap: 'HÁNDICAP',
  hits: 'HITS · PARTIDO Y EQUIPO',
  'hits-bateador': 'HITS DEL BATEADOR',
  ponches: 'PONCHES DEL LANZADOR',
});

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function displayName(value) {
  return String(value || '')
    .replace(/\bOver\b/gi, 'Más de')
    .replace(/\bUnder\b/gi, 'Menos de')
    .replace(/\bO\s*\/\s*U\b/gi, 'Más/Menos')
    .replace(/\s+/g, ' ')
    .trim();
}

// Política de producto compartida con la Apuesta del Día: la probabilidad se
// publica topada al 95%; la fiabilidad se muestra tal cual.
function displayProbability(value) {
  const probability = Math.max(0, Math.min(100, Number(value) || 0));
  if (probability >= 95) return 95;
  return Math.floor((probability + EPSILON) * 100) / 100;
}

function toOption(selection, confidence) {
  const rawProbability = Number(selection.rawProbability ?? selection.probability);
  const odd = Number(selection.odd);
  return {
    id: selection.id ?? null,
    name: displayName(selection.name),
    probability: displayProbability(rawProbability),
    rawProbability,
    confidence: reliabilityPercent(confidence),
    odd: Number.isFinite(odd) && odd > 0 ? odd : null,
  };
}

function compareOptions(a, b) {
  const probabilityDiff = b.rawProbability - a.rawProbability;
  if (Math.abs(probabilityDiff) > EPSILON) return probabilityDiff;
  const reliabilityDiff = (b.confidence || 0) - (a.confidence || 0);
  if (Math.abs(reliabilityDiff) > EPSILON) return reliabilityDiff;
  return String(a.id || a.name || '').localeCompare(String(b.id || b.name || ''));
}

function unwrapAnalysis(value) {
  if (!value || typeof value !== 'object') return {};
  if (value.analysis && typeof value.analysis === 'object'
      && (value.analysis.homeTeam || value.analysis.kickoff || value.analysis._scored)) {
    return value.analysis;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Fútbol
// ---------------------------------------------------------------------------

// Familias que jamás entran aunque su texto mencione goles (defensa ante
// nombres compuestos): resultado, doble oportunidad, ambos marcan, tarjetas,
// remates, faltas y fueras de juego.
const FOOTBALL_EXCLUDED = /btts|ambos\s+equipos|ambos\s+marcan|doble\s+oportunidad|(^|[^a-z])dc_|card|tarjet|winner|ganador|empate|draw|(^|[^a-z])1x2([^a-z]|$)|(^|[^a-z])sot([^a-z]|$)|shotson|shots-on|tiros?\s+a\s+puerta|remates?|foul|falta|offside|fuera\s+de\s+juego/;

export function classifyFootballPremiumOption(selection) {
  const id = normalize(selection?.id);
  const category = normalize(selection?.category);
  const name = normalize(selection?.name);
  const text = [id, category, name].filter(Boolean).join(' ');
  if (!text) return null;
  if (FOOTBALL_EXCLUDED.test(text)) return null;

  // Vocabulario real del context-engine: ah_* / eh_* (hándicap asiático y
  // europeo), *_corners_*, *_goals_* (incluidas mitades 1h/2h).
  if (/^(ah_|eh_)/.test(id) || /^(ah_|eh_)/.test(category) || /handicap|asian/.test(text)) {
    return 'handicap';
  }
  if (/corner/.test(text)) return 'corners';
  if (/goal|goles|(^|[^a-z])gol([^a-z]|$)/.test(text)) return 'goles';
  return null;
}

export function isFootballPremiumEligible(selection) {
  const probability = Number(selection?.rawProbability ?? selection?.probability);
  return Number.isFinite(probability)
    && probability > FOOTBALL_PREMIUM_RULES.minProbabilityExclusive
    && meetsReliability(selection?.confidence, FOOTBALL_PREMIUM_RULES.minReliability);
}

/**
 * Ensambla los partidos publicables de fútbol a partir de filas crudas de
 * match_analysis. Puro: no toca la base de datos (testeable).
 */
export function assembleFootballPremiumMatches(rows, nowMs = Date.now()) {
  const matches = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const analysis = unwrapAnalysis(row?.analysis);
    const combinada = row?.combinada || analysis.combinada;
    if (combinada?.source !== 'context-engine') continue;

    const statusShort = analysis.status?.short || analysis.status;
    if (statusShort && !BETTABLE_FOOTBALL_STATUSES.has(statusShort)) continue;
    const kickoffMs = analysis.kickoff ? new Date(analysis.kickoff).getTime() : 0;
    if (kickoffMs > 0 && kickoffMs <= nowMs + PREMATCH_BUFFER_MS) continue;

    const scored = analysis._scored || row?.analysis?._scored || {};
    const pool = Array.isArray(combinada.selectable) && combinada.selectable.length
      ? combinada.selectable
      : (Array.isArray(combinada.selections) ? combinada.selections : []);

    const groups = { handicap: [], corners: [], goles: [] };
    const seen = new Set();
    for (const selection of pool) {
      const key = selection?.id || JSON.stringify(selection);
      if (seen.has(key)) continue;
      seen.add(key);
      const family = classifyFootballPremiumOption(selection);
      if (!family) continue;
      const evidence = scored?.[selection?.id];
      const confidence = selection?.confidence ?? evidence?.confidence ?? evidence?.conf;
      if (!isFootballPremiumEligible({ ...selection, confidence })) continue;
      groups[family].push(toOption(selection, confidence));
    }

    const optionsCount = groups.handicap.length + groups.corners.length + groups.goles.length;
    if (!optionsCount) continue;
    for (const family of Object.keys(groups)) groups[family].sort(compareOptions);

    matches.push({
      fixtureId: Number(row.fixture_id ?? row.fixtureId) || null,
      homeTeam: analysis.homeTeam || null,
      awayTeam: analysis.awayTeam || null,
      league: analysis.league || null,
      kickoff: analysis.kickoff || null,
      optionsCount,
      groups,
    });
  }

  matches.sort((a, b) => {
    const timeA = a.kickoff ? new Date(a.kickoff).getTime() : Infinity;
    const timeB = b.kickoff ? new Date(b.kickoff).getTime() : Infinity;
    if (timeA !== timeB) return timeA - timeB;
    return (a.fixtureId || 0) - (b.fixtureId || 0);
  });
  return matches;
}

export async function buildFootballPremiumBoard(date, nowMs = Date.now()) {
  const { data, error } = await (await db())
    .from('match_analysis')
    .select('fixture_id, analysis, combinada, cache_version')
    .eq('date', date)
    .gte('cache_version', 20);
  if (error) throw new Error(`match_analysis: ${error.message || error}`);

  const analyzedCount = Array.isArray(data) ? data.length : 0;
  const matches = assembleFootballPremiumMatches(data, nowMs);
  return {
    fecha: date,
    sport: 'futbol',
    analyzedCount,
    matches,
    totalOptions: matches.reduce((total, match) => total + match.optionsCount, 0),
    rules: FOOTBALL_PREMIUM_RULES,
  };
}

// ---------------------------------------------------------------------------
// Béisbol
// ---------------------------------------------------------------------------

export function classifyBaseballPremiumOption(selection) {
  const category = String(selection?.category || '');
  if (/^handicap-/.test(category) || /^(?:first|inning)\d+-handicap-/.test(category)) {
    return 'handicap';
  }
  if (/^total-/.test(category)
      || /^team-total-/.test(category)
      || /^(?:first|inning)\d+-(?:team-)?total-/.test(category)
      || /^(?:first|inning)\d+-run$/.test(category)) {
    return 'carreras';
  }
  if (/^stat-hits-/.test(category)) return 'hits';
  if (/^player-hits-/.test(category)) return 'hits-bateador';
  if (/^player-strikeouts-/.test(category)) return 'ponches';
  return null;
}

export function isBaseballPremiumEligible(selection) {
  const probability = Number(selection?.rawProbability ?? selection?.probability);
  return Number.isFinite(probability)
    && probability + EPSILON >= BASEBALL_PREMIUM_RULES.minProbability
    && meetsReliability(
      selection?.reliability ?? selection?.confidence,
      BASEBALL_PREMIUM_RULES.minReliability,
    );
}

/**
 * Ensambla los juegos publicables de béisbol a partir de filas crudas. Puro.
 *
 * `bogotaDate` (opcional) limita a los juegos cuyo `start_time` cae en ese día
 * de Bogotá. Es necesario porque la columna `date` de baseball_match_analysis
 * guarda la fecha UTC del juego: la cartelera de un día de Bogotá queda
 * repartida entre dos fechas UTC (los juegos de las 19:00+ Bogotá pertenecen
 * al día UTC siguiente).
 */
export function assembleBaseballPremiumMatches(rows, nowMs = Date.now(), bogotaDate = null) {
  const matches = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const startMs = row?.start_time ? new Date(row.start_time).getTime() : 0;
    if (!startMs || startMs <= nowMs + PREMATCH_BUFFER_MS) continue;
    if (bogotaDate && bogotaDayOf(row.start_time) !== bogotaDate) continue;

    const pool = Array.isArray(row?.combinada?.selectable) ? row.combinada.selectable : [];
    const groups = { carreras: [], handicap: [], hits: [], 'hits-bateador': [], ponches: [] };
    for (const selection of pool) {
      const family = classifyBaseballPremiumOption(selection);
      if (!family) continue;
      if (!isBaseballPremiumEligible(selection)) continue;
      groups[family].push(toOption(selection, selection?.reliability ?? selection?.confidence));
    }

    const optionsCount = Object.values(groups).reduce((total, list) => total + list.length, 0);
    if (!optionsCount) continue;
    for (const family of Object.keys(groups)) groups[family].sort(compareOptions);

    matches.push({
      fixtureId: Number(row.fixture_id ?? row.fixtureId) || null,
      homeTeam: row.home_team || null,
      awayTeam: row.away_team || null,
      league: row.league_name || null,
      kickoff: row.start_time || null,
      optionsCount,
      groups,
    });
  }

  matches.sort((a, b) => {
    const timeA = a.kickoff ? new Date(a.kickoff).getTime() : Infinity;
    const timeB = b.kickoff ? new Date(b.kickoff).getTime() : Infinity;
    if (timeA !== timeB) return timeA - timeB;
    return (a.fixtureId || 0) - (b.fixtureId || 0);
  });
  return matches;
}

export async function buildBaseballPremiumBoard(date, nowMs = Date.now()) {
  // La cartelera del día Bogotá `date` vive en dos fechas UTC de la tabla
  // (ver assembleBaseballPremiumMatches): se piden ambas y se filtra por el
  // día Bogotá real de cada start_time.
  const { data, error } = await (await db())
    .from('baseball_match_analysis')
    .select('fixture_id, date, league_name, home_team, away_team, status, start_time, combinada')
    .in('date', [date, shiftIsoDate(date, 1)]);
  if (error) throw new Error(`baseball_match_analysis: ${error.message || error}`);

  const rows = Array.isArray(data) ? data : [];
  const analyzedCount = rows.filter((row) => row?.start_time && bogotaDayOf(row.start_time) === date).length;
  const matches = assembleBaseballPremiumMatches(rows, nowMs, date);
  return {
    fecha: date,
    sport: 'baseball',
    analyzedCount,
    matches,
    totalOptions: matches.reduce((total, match) => total + match.optionsCount, 0),
    rules: BASEBALL_PREMIUM_RULES,
  };
}

// El día del béisbol se cuenta en Bogotá, igual que el motor (bogotaToday del
// worker); en-CA produce YYYY-MM-DD directamente.
export function bogotaToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function bogotaDayOf(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return bogotaToday(date);
}

export function shiftIsoDate(isoDate, days) {
  const value = new Date(`${isoDate}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function utcToday(now = new Date()) {
  return now.toISOString().split('T')[0];
}
