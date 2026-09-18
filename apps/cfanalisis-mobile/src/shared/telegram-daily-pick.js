import { meetsReliability, reliabilityPercent } from './recommendation-policy.js';

/**
 * Apuesta del día de Telegram — formato por partido.
 *
 * Ya no se arma una combinada: se publican como máximo los dos partidos con
 * mejor probabilidad media y, a igualdad, mejor fiabilidad media. Cada partido
 * aporta entre una y tres de sus mejores opciones.
 *
 * La cuota NO ordena nada: solo actúa como filtro inferior (>=1.20) y no tiene
 * techo. Entre dos opciones válidas siempre gana la de mayor probabilidad y,
 * a igualdad, la de mayor fiabilidad — aunque pague menos.
 */

const MIN_PROBABILITY = 85;
const MIN_RELIABILITY = 90;
const MIN_SELECTION_ODD = 1.2;
const MIN_OPTIONS_PER_MATCH = 1;
const MAX_OPTIONS_PER_MATCH = 3;
const MAX_MATCHES = 2;
const EPSILON = 1e-9;

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function marketText(selection) {
  return normalize([
    selection?.id,
    selection?.category,
    selection?.name,
  ].filter(Boolean).join(' '));
}

export function isTelegramMarketAllowed(selection) {
  const text = marketText(selection);
  if (!text) return false;

  // Reglas comerciales explícitas: nunca publicar hándicaps, resultados,
  // empates, ambos marcan, faltas, fueras de juego ni tiros que no sean a puerta.
  if (/handicap|asian|winner|ganador|empate|draw|btts|ambos marcan|foul|falta|offside|fuera de juego/.test(text)) {
    return false;
  }

  const isShotOnTarget = /(^|[^a-z])sot([^a-z]|$)|shotson|shots-on|tiros? a puerta|remates? a puerta/.test(text);
  const isCards = /card|tarjet/.test(text);
  const isCorners = /corner/.test(text);
  const isGoals = /goal|gol/.test(text);

  // "shots"/"tiros" por sí solos son remates totales y no cumplen la regla.
  return isShotOnTarget || isCards || isCorners || isGoals;
}

function displayName(value) {
  return String(value || '')
    .replace(/\bOver\b/gi, 'Más de')
    .replace(/\bUnder\b/gi, 'Menos de')
    .replace(/\bO\s*\/\s*U\b/gi, 'Más/Menos')
    .replace(/\s+/g, ' ')
    .trim();
}

function fixtureKey(selection) {
  return String(selection?.fixtureId || selection?.matchName || '').trim();
}

function displayProbability(value) {
  const probability = Math.max(0, Math.min(100, Number(value) || 0));
  if (probability >= 95) return 95;
  return Math.floor((probability + 1e-9) * 100) / 100;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Probabilidad primero y fiabilidad después; la cuota nunca desempata porque no
// mide calidad. El id cierra el orden para que la salida sea determinista.
function compareOptions(a, b) {
  const probabilityDiff = b.rawProbability - a.rawProbability;
  if (Math.abs(probabilityDiff) > EPSILON) return probabilityDiff;

  const reliabilityDiff = b.confidence - a.confidence;
  if (Math.abs(reliabilityDiff) > EPSILON) return reliabilityDiff;

  return String(a.id || a.name || '').localeCompare(String(b.id || b.name || ''));
}

function compareMatches(a, b) {
  const probabilityDiff = b.averageProbability - a.averageProbability;
  if (Math.abs(probabilityDiff) > EPSILON) return probabilityDiff;

  const reliabilityDiff = b.averageReliability - a.averageReliability;
  if (Math.abs(reliabilityDiff) > EPSILON) return reliabilityDiff;

  // Desempate opción a opción, de la mejor a la peor, antes de caer en el id.
  const sharedOptions = Math.min(a.options.length, b.options.length);
  for (let index = 0; index < sharedOptions; index += 1) {
    const optionDiff = compareOptions(a.options[index], b.options[index]);
    if (Math.abs(optionDiff) > EPSILON) return optionDiff;
  }

  const optionCountDiff = b.options.length - a.options.length;
  if (optionCountDiff !== 0) return optionCountDiff;

  return String(a.fixtureId ?? a.matchName ?? '')
    .localeCompare(String(b.fixtureId ?? b.matchName ?? ''));
}

function isEligibleOption(selection) {
  const probability = Number(selection?.rawProbability ?? selection?.probability);
  const odd = Number(selection?.odd);
  return Number.isFinite(probability)
    && probability + EPSILON >= MIN_PROBABILITY
    && meetsReliability(selection?.confidence, MIN_RELIABILITY)
    && Number.isFinite(odd)
    && odd >= MIN_SELECTION_ODD - EPSILON;
}

/**
 * Devuelve como máximo los dos mejores partidos publicables, cada uno con entre
 * una y tres de sus mejores opciones.
 */
export function selectTelegramDailyPick(selections) {
  const eligible = (Array.isArray(selections) ? selections : [])
    .filter(isTelegramMarketAllowed)
    .filter(isEligibleOption)
    .map(selection => ({
      ...selection,
      name: displayName(selection.name),
      probability: Number(selection.probability),
      rawProbability: Number(selection.rawProbability ?? selection.probability),
      confidence: reliabilityPercent(selection.confidence),
      odd: Number(selection.odd),
    }));

  const byFixture = new Map();
  for (const option of eligible) {
    const key = fixtureKey(option);
    if (!key) continue;
    if (!byFixture.has(key)) byFixture.set(key, []);
    byFixture.get(key).push(option);
  }

  const candidates = [];
  for (const options of byFixture.values()) {
    if (options.length < MIN_OPTIONS_PER_MATCH) continue;
    const best = [...options].sort(compareOptions).slice(0, MAX_OPTIONS_PER_MATCH);
    const reference = best[0];
    candidates.push({
      fixtureId: reference.fixtureId ?? null,
      matchName: reference.matchName ?? null,
      homeTeam: reference.homeTeam ?? null,
      awayTeam: reference.awayTeam ?? null,
      homeId: reference.homeId ?? null,
      awayId: reference.awayId ?? null,
      homeLogo: reference.homeLogo ?? null,
      awayLogo: reference.awayLogo ?? null,
      league: reference.league ?? null,
      leagueId: reference.leagueId ?? null,
      leagueLogo: reference.leagueLogo ?? null,
      kickoff: reference.kickoff ?? null,
      averageProbability: average(best.map(option => option.rawProbability)),
      averageReliability: average(best.map(option => option.confidence)),
      options: best.map(option => ({
        id: option.id ?? null,
        category: option.category ?? null,
        name: option.name,
        probability: displayProbability(option.rawProbability),
        rawProbability: option.rawProbability,
        confidence: option.confidence,
        odd: option.odd,
      })),
    });
  }

  const matches = candidates.sort(compareMatches).slice(0, MAX_MATCHES).map(match => ({
    ...match,
    averageProbability: displayProbability(match.averageProbability),
    averageReliability: Math.floor((match.averageReliability + 1e-9) * 100) / 100,
  }));

  return {
    matches,
    eligibleCount: eligible.length,
    eligibleMatchCount: candidates.length,
  };
}

export const TELEGRAM_DAILY_PICK_RULES = Object.freeze({
  minProbability: MIN_PROBABILITY,
  minReliability: MIN_RELIABILITY,
  minSelectionOdd: MIN_SELECTION_ODD,
  minOptionsPerMatch: MIN_OPTIONS_PER_MATCH,
  maxOptionsPerMatch: MAX_OPTIONS_PER_MATCH,
  maxMatches: MAX_MATCHES,
});

export function meetsTelegramDailyPickReliability(value) {
  return meetsReliability(value, MIN_RELIABILITY);
}

export function isTelegramDailyPickOptionEligible(selection) {
  return isTelegramMarketAllowed(selection) && isEligibleOption(selection);
}
