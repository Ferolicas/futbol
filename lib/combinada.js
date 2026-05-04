// ===================== COMBINADA (ACCUMULATOR) LOGIC =====================

/**
 * Category definitions for deduplication.
 * Each category keeps only the single highest-probability market.
 * When two markets tie in probability, prefer the harder one (higher threshold).
 */
const CATEGORIES = {
  goals:        ['over-15', 'over-25', 'over-35', 'under-35'],
  corners:      ['corners-over-85', 'corners-over-95', 'corners-over-105'],
  cards:        ['cards-over-25', 'cards-over-35', 'cards-over-45'],
  btts:         ['btts-yes', 'btts-no'],
  winner:       ['winner-home', 'winner-draw', 'winner-away'],
};

// Difficulty rank within category — higher = harder. Used to break ties.
const DIFFICULTY = {
  'over-15': 1, 'over-25': 2, 'over-35': 3, 'under-35': 3,
  'corners-over-85': 1, 'corners-over-95': 2, 'corners-over-105': 3,
  'cards-over-25': 1, 'cards-over-35': 2, 'cards-over-45': 3,
};

/**
 * Given a list of markets, deduplicate so there is at most ONE market per
 * category. Within each category the market with the highest probability wins.
 * On tie, pick the harder market (higher threshold).
 */
function deduplicateByCategory(markets) {
  const idToCategory = {};
  for (const [cat, ids] of Object.entries(CATEGORIES)) {
    for (const id of ids) {
      idToCategory[id] = cat;
    }
  }

  const bestByCategory = {};
  const uncategorized = [];

  for (const m of markets) {
    const cat = idToCategory[m.id];
    if (!cat) {
      // Per-team markets have their own category like 'home-corners', 'away-goals', etc.
      // Use m.category for dedup
      const perTeamCat = m.category;
      if (perTeamCat && perTeamCat.startsWith('home-') || perTeamCat && perTeamCat.startsWith('away-')) {
        if (!bestByCategory[perTeamCat] || m.probability > bestByCategory[perTeamCat].probability ||
            (m.probability === bestByCategory[perTeamCat].probability && (DIFFICULTY[m.id] || 0) > (DIFFICULTY[bestByCategory[perTeamCat].id] || 0))) {
          bestByCategory[perTeamCat] = m;
        }
        continue;
      }
      uncategorized.push(m);
      continue;
    }
    if (!bestByCategory[cat] || m.probability > bestByCategory[cat].probability ||
        (m.probability === bestByCategory[cat].probability && (DIFFICULTY[m.id] || 0) > (DIFFICULTY[bestByCategory[cat].id] || 0))) {
      bestByCategory[cat] = m;
    }
  }

  return [...Object.values(bestByCategory), ...uncategorized];
}

export function buildCombinada(probabilities, odds, playerHighlights, teamNames) {
  const allMarkets = [];
  const homeName = teamNames?.home || 'Local';
  const awayName = teamNames?.away || 'Visitante';

  // Helper: solo añade el mercado si existe cuota real (≥1.01) en al menos
  // una de las 8 casas autorizadas. Sin cuota → no se recomienda nunca.
  const push = (m, oddVal) => {
    const odd = parseFloat(oddVal);
    if (!isFinite(odd) || odd <= 1) return;
    allMarkets.push({ ...m, odd });
  };

  // --- BTTS ---
  if (probabilities.btts >= 70) {
    push({ id: 'btts-yes', category: 'btts', name: 'Ambos marcan — SI', probability: probabilities.btts }, odds?.btts?.yes);
  }
  if (probabilities.bttsNo >= 70) {
    push({ id: 'btts-no', category: 'btts', name: 'Ambos marcan — NO', probability: probabilities.bttsNo }, odds?.btts?.no);
  }

  // --- Match Winner ---
  const { winner } = probabilities;
  if (winner.home >= 70) push({ id: 'winner-home', category: 'winner', name: `Ganador — ${homeName}`, probability: winner.home }, odds?.matchWinner?.home);
  if (winner.draw >= 70) push({ id: 'winner-draw', category: 'winner', name: 'Empate', probability: winner.draw }, odds?.matchWinner?.draw);
  if (winner.away >= 70) push({ id: 'winner-away', category: 'winner', name: `Ganador — ${awayName}`, probability: winner.away }, odds?.matchWinner?.away);

  // --- Over/Under Goals (totales) ---
  const ou = probabilities.overUnder;
  if (ou.over15 >= 70) push({ id: 'over-15', category: 'goals', name: 'Goles totales — Más de 1.5', probability: ou.over15 }, odds?.overUnder?.['Over_1_5']);
  if (ou.over25 >= 70) push({ id: 'over-25', category: 'goals', name: 'Goles totales — Más de 2.5', probability: ou.over25 }, odds?.overUnder?.['Over_2_5']);
  if (ou.over35 >= 70) push({ id: 'over-35', category: 'goals', name: 'Goles totales — Más de 3.5', probability: ou.over35 }, odds?.overUnder?.['Over_3_5']);
  if (ou.under35 >= 90) push({ id: 'under-35', category: 'goals', name: 'Goles totales — Menos de 3.5', probability: ou.under35 }, odds?.overUnder?.['Under_3_5']);

  // --- Corners totales ---
  const c = probabilities.corners;
  if (c.over85  >= 70) push({ id: 'corners-over-85',  category: 'corners', name: 'Córners totales — Más de 8.5',  probability: c.over85  }, odds?.corners?.['Over_8_5']);
  if (c.over95  >= 70) push({ id: 'corners-over-95',  category: 'corners', name: 'Córners totales — Más de 9.5',  probability: c.over95  }, odds?.corners?.['Over_9_5']);
  if (c.over105 >= 70) push({ id: 'corners-over-105', category: 'corners', name: 'Córners totales — Más de 10.5', probability: c.over105 }, odds?.corners?.['Over_10_5']);

  // --- Cards totales ---
  const ca = probabilities.cards;
  if (ca.over25 >= 70) push({ id: 'cards-over-25', category: 'cards', name: 'Tarjetas totales — Más de 2.5', probability: ca.over25 }, odds?.cards?.['Over_2_5']);
  if (ca.over35 >= 70) push({ id: 'cards-over-35', category: 'cards', name: 'Tarjetas totales — Más de 3.5', probability: ca.over35 }, odds?.cards?.['Over_3_5']);
  if (ca.over45 >= 70) push({ id: 'cards-over-45', category: 'cards', name: 'Tarjetas totales — Más de 4.5', probability: ca.over45 }, odds?.cards?.['Over_4_5']);

  // Per-team, goal timing y player markets se omiten: ninguna casa ofrece esas
  // opciones específicas a través de nuestras fuentes de cuotas, así que no
  // se pueden apostar y no deben aparecer (regla del usuario).

  // =========================================================================
  // Dedup, sort, build combinada — solo mercados con cuota real.
  // =========================================================================
  const deduplicated = deduplicateByCategory(allMarkets);
  const selected = deduplicated
    .filter(m => m.probability >= 70 && m.odd && m.odd > 1)
    .sort((a, b) => b.probability - a.probability);

  if (selected.length === 0) {
    return {
      selections: [],
      combinedOdd: null,
      combinedProbability: 0,
      highRisk: false,
      hasRealOdds: false,
      threshold: 70,
      totalMarkets: allMarkets.length,
      deduplicatedMarkets: deduplicated.length,
    };
  }

  const combinedOdd = selected.reduce((acc, m) => acc * m.odd, 1);
  const combinedProbability = selected.reduce((acc, m) => acc + m.probability, 0) / selected.length;
  const effectiveThreshold = Math.min(...selected.map(m => m.probability));

  return {
    selections: selected,
    combinedOdd: +combinedOdd.toFixed(2),
    combinedProbability: +combinedProbability.toFixed(1),
    highRisk: combinedProbability < 60,
    hasRealOdds: true,
    threshold: effectiveThreshold,
    totalMarkets: allMarkets.length,
    deduplicatedMarkets: deduplicated.length,
  };
}
