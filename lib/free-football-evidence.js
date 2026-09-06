import scoredAdapter from './model-to-scored.js';
import { entryReliabilityPercent } from './reliability.js';

function inverse(evidence) {
  if (!evidence || typeof evidence !== 'object') return evidence;
  if (Array.isArray(evidence)) return evidence.map(inverse);
  const result = Object.fromEntries(Object.entries(evidence).map(([key, value]) => [key, value && typeof value === 'object' ? inverse(value) : value]));
  if (Number.isFinite(Number(evidence.n)) && evidence.hits != null) result.hits = Number(evidence.n) - Number(evidence.hits);
  return result;
}

// Separate evidence for Free. This never mutates the market tree or the
// confidence/cutoffs used by the paid catalog, Telegram or final verdict.
export function freeFootballEvidence(markets) {
  const freeMarkets = {};
  for (const [key, market] of Object.entries(markets || {})) {
    if (market?.kind !== 'ou') continue;
    freeMarkets[key] = { ...market, lines: (market.lines || []).map(line => {
      const evidence = line.chain?.find(step => step.step === 'empirical-weighted');
      return { ...line, conf: (entryReliabilityPercent({ evidence }, 60) ?? 0) / 100,
        underConf: (entryReliabilityPercent({ evidence: inverse(evidence) }, 60) ?? 0) / 100 };
    }) };
  }
  return Object.fromEntries(Object.entries(scoredAdapter.modelToScored(freeMarkets))
    .filter(([, row]) => row.prob_final >= .6 && row.prob_final <= .7 && row.confidence >= .9));
}
