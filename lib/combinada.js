// ===================== COMBINADA (ACCUMULATOR) LOGIC =====================

/**
 * Category definitions for deduplication.
 * Each category keeps only the single highest-probability market.
 */
const CATEGORIES = {
  goals:   ['over-15', 'over-25', 'over-35', 'under-25'],
  corners: ['corners-over-85', 'corners-over-95', 'corners-over-105'],
  cards:   ['cards-over-25', 'cards-over-35', 'cards-over-45'],
  btts:    ['btts-yes', 'btts-no'],
  winner:  ['winner-home', 'winner-draw', 'winner-away'],
};

/**
 * Given a list of markets, deduplicate so there is at most ONE market per
 * category. Within each category the market with the highest probability wins.
 */
function deduplicateByCategory(markets) {
  // Build a reverse lookup: marketId -> categoryKey
  const idToCategory = {};
  for (const [cat, ids] of Object.entries(CATEGORIES)) {
    for (const id of ids) {
      idToCategory[id] = cat;
    }
  }

  const bestByCategory = {};  // categoryKey -> best market
  const uncategorized = [];   // markets not in any predefined category

  for (const m of markets) {
    const cat = idToCategory[m.id];
    if (!cat) {
      // Not in a predefined category (e.g., scorer markets) — keep all
      uncategorized.push(m);
      continue;
    }
    if (!bestByCategory[cat] || m.probability > bestByCategory[cat].probability) {
      bestByCategory[cat] = m;
    }
  }

  return [...Object.values(bestByCategory), ...uncategorized];
}

export function buildCombinada(probabilities, odds, playerHighlights) {
  const allMarkets = [];

  // --- BTTS ---
  if (probabilities.btts >= 60) {
    allMarkets.push({
      id: 'btts-yes',
      category: 'btts',
      name: 'Ambos marcan — SI',
      probability: probabilities.btts,
      odd: odds?.btts?.yes || null,
    });
  }
  if (probabilities.bttsNo >= 60) {
    allMarkets.push({
      id: 'btts-no',
      category: 'btts',
      name: 'Ambos marcan — NO',
      probability: probabilities.bttsNo,
      odd: odds?.btts?.no || null,
    });
  }

  // --- Match Winner ---
  const { winner } = probabilities;
  if (winner.home >= 60) {
    allMarkets.push({
      id: 'winner-home',
      category: 'winner',
      name: 'Ganador — Local',
      probability: winner.home,
      odd: odds?.matchWinner?.home || null,
    });
  }
  if (winner.draw >= 60) {
    allMarkets.push({
      id: 'winner-draw',
      category: 'winner',
      name: 'Empate',
      probability: winner.draw,
      odd: odds?.matchWinner?.draw || null,
    });
  }
  if (winner.away >= 60) {
    allMarkets.push({
      id: 'winner-away',
      category: 'winner',
      name: 'Ganador — Visitante',
      probability: winner.away,
      odd: odds?.matchWinner?.away || null,
    });
  }

  // --- Over/Under Goals ---
  const ou = probabilities.overUnder;
  if (ou.over15 >= 60) {
    allMarkets.push({
      id: 'over-15',
      category: 'goals',
      name: 'Mas de 1.5 goles',
      probability: ou.over15,
      odd: odds?.overUnder?.['Over_1_5'] || null,
    });
  }
  if (ou.over25 >= 60) {
    allMarkets.push({
      id: 'over-25',
      category: 'goals',
      name: 'Mas de 2.5 goles',
      probability: ou.over25,
      odd: odds?.overUnder?.['Over_2_5'] || null,
    });
  }
  if (ou.over35 >= 60) {
    allMarkets.push({
      id: 'over-35',
      category: 'goals',
      name: 'Mas de 3.5 goles',
      probability: ou.over35,
      odd: odds?.overUnder?.['Over_3_5'] || null,
    });
  }
  if (ou.under25 >= 60) {
    allMarkets.push({
      id: 'under-25',
      category: 'goals',
      name: 'Menos de 2.5 goles',
      probability: ou.under25,
      odd: odds?.overUnder?.['Under_2_5'] || null,
    });
  }

  // --- Corners ---
  const c = probabilities.corners;
  if (c.over85 >= 60) {
    allMarkets.push({
      id: 'corners-over-85',
      category: 'corners',
      name: 'Mas de 8.5 corners',
      probability: c.over85,
      odd: null,
    });
  }
  if (c.over95 >= 60) {
    allMarkets.push({
      id: 'corners-over-95',
      category: 'corners',
      name: 'Mas de 9.5 corners',
      probability: c.over95,
      odd: null,
    });
  }
  if (c.over105 >= 60) {
    allMarkets.push({
      id: 'corners-over-105',
      category: 'corners',
      name: 'Mas de 10.5 corners',
      probability: c.over105,
      odd: null,
    });
  }

  // --- Cards ---
  const ca = probabilities.cards;
  if (ca.over25 >= 60) {
    allMarkets.push({
      id: 'cards-over-25',
      category: 'cards',
      name: 'Mas de 2.5 tarjetas',
      probability: ca.over25,
      odd: null,
    });
  }
  if (ca.over35 >= 60) {
    allMarkets.push({
      id: 'cards-over-35',
      category: 'cards',
      name: 'Mas de 3.5 tarjetas',
      probability: ca.over35,
      odd: null,
    });
  }
  if (ca.over45 >= 60) {
    allMarkets.push({
      id: 'cards-over-45',
      category: 'cards',
      name: 'Mas de 4.5 tarjetas',
      probability: ca.over45,
      odd: null,
    });
  }

  // --- Goleador ---
  if (playerHighlights?.scorers?.length > 0) {
    const topScorer = playerHighlights.scorers[0];
    const matchesWithGoal = topScorer.goals.filter(g => g >= 1).length;
    const totalMatches = topScorer.goals.length || 5;
    const scorerProb = Math.round((matchesWithGoal / totalMatches) * 100);
    if (scorerProb >= 60) {
      allMarkets.push({
        id: `scorer-${topScorer.id}`,
        category: 'scorer',
        name: `Goleador — ${topScorer.name}`,
        probability: scorerProb,
        odd: null,
      });
    }
  }

  // =========================================================================
  // Step 1: Deduplicate — one market per category, highest probability wins
  // =========================================================================
  const deduplicated = deduplicateByCategory(allMarkets);

  // =========================================================================
  // Step 2: Filter to "probable" recommendations (>= 70%)
  // =========================================================================
  const probable = deduplicated.filter(m => m.probability >= 70);

  // Sort by probability descending
  probable.sort((a, b) => b.probability - a.probability);

  // =========================================================================
  // Step 3: Build the combinada selection
  // =========================================================================
  // If we have enough >= 70% picks, use them directly.
  // Fall back to >= 65% if fewer than 2 strong picks.
  let selected;
  if (probable.length >= 2) {
    selected = probable;
  } else {
    // Relax threshold slightly but still only show likely outcomes
    const relaxed = deduplicated
      .filter(m => m.probability >= 65)
      .sort((a, b) => b.probability - a.probability);
    selected = relaxed;
  }

  // Limit to 6 selections max
  selected = selected.slice(0, 6);

  // Calculate combined odds and probability (average, not multiplicative)
  const combinedOdd = selected.reduce((acc, m) => m.odd ? acc * m.odd : acc, 1);
  const combinedProbability = selected.length > 0
    ? selected.reduce((acc, m) => acc + m.probability, 0) / selected.length
    : 0;
  const highRisk = combinedProbability < 60;

  // Determine the effective threshold used
  const effectiveThreshold = selected.length > 0
    ? Math.min(...selected.map(m => m.probability))
    : 70;

  return {
    selections: selected,
    combinedOdd: +combinedOdd.toFixed(2),
    combinedProbability: +combinedProbability.toFixed(1),
    highRisk,
    threshold: effectiveThreshold,
    totalMarkets: allMarkets.length,
    deduplicatedMarkets: deduplicated.length,
  };
}
