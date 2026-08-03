import { meetsReliability, reliabilityPercent } from './recommendation-policy.js';

const MIN_PROBABILITY = 80;
const MIN_RELIABILITY = 80;
const MIN_SELECTION_ODD = 1.2;
const MAX_SELECTION_ODD = 1.6;
const MIN_COMBINED_ODD = 1.5;
const MAX_COMBINED_ODD = 2;
const MIN_COMBINED_PROBABILITY = 80;
const MAX_LEGS = 3;
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
  return String(selection.fixtureId || selection.matchName || '').trim();
}

function combinedProbability(selections) {
  return selections.reduce(
    (acc, selection) => acc * (Number(selection.rawProbability ?? selection.probability) / 100),
    1,
  ) * 100;
}

function combinedOdd(selections) {
  return selections.reduce((acc, selection) => acc * Number(selection.odd), 1);
}

function minimumReliability(selections) {
  if (!selections.length) return 0;
  return Math.min(...selections.map(selection => Number(selection.confidence)));
}

function averageReliability(selections) {
  if (!selections.length) return 0;
  return selections.reduce((sum, selection) => sum + Number(selection.confidence), 0) / selections.length;
}

function displayProbability(value) {
  const probability = Math.max(0, Math.min(100, Number(value) || 0));
  if (probability >= 95) return 95;
  return Math.floor((probability + 1e-9) * 100) / 100;
}

function compareCombinations(a, b) {
  const probabilityDiff = combinedProbability(b) - combinedProbability(a);
  if (Math.abs(probabilityDiff) > EPSILON) return probabilityDiff;

  const minimumReliabilityDiff = minimumReliability(b) - minimumReliability(a);
  if (Math.abs(minimumReliabilityDiff) > EPSILON) return minimumReliabilityDiff;

  const averageReliabilityDiff = averageReliability(b) - averageReliability(a);
  if (Math.abs(averageReliabilityDiff) > EPSILON) return averageReliabilityDiff;

  const oddDiff = combinedOdd(b) - combinedOdd(a);
  if (Math.abs(oddDiff) > EPSILON) return oddDiff;

  return a.map(item => fixtureKey(item)).join('|')
    .localeCompare(b.map(item => fixtureKey(item)).join('|'));
}

function combinationsOf(candidates, size) {
  const combinations = [];

  function visit(start, current, currentOdd, fixtures) {
    if (current.length === size) {
      if (currentOdd >= MIN_COMBINED_ODD - EPSILON
          && currentOdd <= MAX_COMBINED_ODD + EPSILON
          && combinedProbability(current) >= MIN_COMBINED_PROBABILITY - EPSILON) {
        combinations.push([...current]);
      }
      return;
    }

    for (let index = start; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const key = fixtureKey(candidate);
      if (!key || fixtures.has(key)) continue;

      const nextOdd = currentOdd * Number(candidate.odd);
      if (nextOdd > MAX_COMBINED_ODD + EPSILON) continue;

      fixtures.add(key);
      current.push(candidate);
      visit(index + 1, current, nextOdd, fixtures);
      current.pop();
      fixtures.delete(key);
    }
  }

  visit(0, [], 1, new Set());
  return combinations;
}

export function selectTelegramDailyPick(selections) {
  const candidates = (Array.isArray(selections) ? selections : [])
    .filter(isTelegramMarketAllowed)
    .filter((selection) => {
      const probability = Number(selection?.rawProbability ?? selection?.probability);
      const reliability = reliabilityPercent(selection?.confidence);
      const odd = Number(selection?.odd);
      return Number.isFinite(probability)
        && probability >= MIN_PROBABILITY
        && meetsReliability(reliability, MIN_RELIABILITY)
        && Number.isFinite(odd)
        && odd >= MIN_SELECTION_ODD - EPSILON
        && odd <= MAX_SELECTION_ODD + EPSILON;
    })
    .map(selection => ({
      ...selection,
      name: displayName(selection.name),
      probability: Number(selection.probability),
      rawProbability: Number(selection.rawProbability ?? selection.probability),
      confidence: reliabilityPercent(selection.confidence),
      odd: Number(selection.odd),
    }))
    .sort((a, b) =>
      b.rawProbability - a.rawProbability
      || b.confidence - a.confidence
      || b.odd - a.odd
      || fixtureKey(a).localeCompare(fixtureKey(b))
    );

  // Acotar el espacio combinatorio sin perder calidad: solo se consideran las
  // 60 mejores opciones y jamás dos mercados del mismo partido.
  const shortlist = candidates.slice(0, 60);
  let selected = null;
  for (let size = 1; size <= MAX_LEGS; size += 1) {
    const valid = combinationsOf(shortlist, size).sort(compareCombinations);
    if (valid.length) {
      selected = valid[0];
      break;
    }
  }

  if (!selected) {
    return {
      selections: [],
      combinedOdd: null,
      combinedProbability: 0,
      rawCombinedProbability: 0,
      eligibleCount: candidates.length,
    };
  }

  const odd = combinedOdd(selected);
  const probability = combinedProbability(selected);
  return {
    selections: selected.map(selection => ({
      ...selection,
      probability: displayProbability(selection.rawProbability ?? selection.probability),
    })),
    combinedOdd: +odd.toFixed(2),
    combinedProbability: displayProbability(probability),
    rawCombinedProbability: Math.round((probability + Number.EPSILON) * 100) / 100,
    eligibleCount: candidates.length,
  };
}

export const TELEGRAM_DAILY_PICK_RULES = Object.freeze({
  minProbability: MIN_PROBABILITY,
  minReliability: MIN_RELIABILITY,
  minSelectionOdd: MIN_SELECTION_ODD,
  maxSelectionOdd: MAX_SELECTION_ODD,
  minCombinedOdd: MIN_COMBINED_ODD,
  maxCombinedOdd: MAX_COMBINED_ODD,
  minCombinedProbability: MIN_COMBINED_PROBABILITY,
  maxLegs: MAX_LEGS,
});

export function meetsTelegramDailyPickReliability(value) {
  return meetsReliability(value, MIN_RELIABILITY);
}
