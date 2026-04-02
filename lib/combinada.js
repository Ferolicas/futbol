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
  timing:       ['timing-combined'],
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

  // --- BTTS ---
  if (probabilities.btts >= 70) {
    allMarkets.push({
      id: 'btts-yes', category: 'btts',
      name: 'Ambos marcan — SI',
      probability: probabilities.btts,
      odd: odds?.btts?.yes || null,
    });
  }
  if (probabilities.bttsNo >= 70) {
    allMarkets.push({
      id: 'btts-no', category: 'btts',
      name: 'Ambos marcan — NO',
      probability: probabilities.bttsNo,
      odd: odds?.btts?.no || null,
    });
  }

  // --- Match Winner ---
  const { winner } = probabilities;
  if (winner.home >= 70) {
    allMarkets.push({
      id: 'winner-home', category: 'winner',
      name: `Ganador — ${homeName}`,
      probability: winner.home,
      odd: odds?.matchWinner?.home || null,
    });
  }
  if (winner.draw >= 70) {
    allMarkets.push({
      id: 'winner-draw', category: 'winner',
      name: 'Empate',
      probability: winner.draw,
      odd: odds?.matchWinner?.draw || null,
    });
  }
  if (winner.away >= 70) {
    allMarkets.push({
      id: 'winner-away', category: 'winner',
      name: `Ganador — ${awayName}`,
      probability: winner.away,
      odd: odds?.matchWinner?.away || null,
    });
  }

  // --- Over/Under Goals (totales) ---
  // No "menos de" markets except "menos de 3.5" with ≥90% probability
  const ou = probabilities.overUnder;
  if (ou.over15 >= 70) {
    allMarkets.push({
      id: 'over-15', category: 'goals',
      name: 'Goles totales — Más de 1.5',
      probability: ou.over15,
      odd: odds?.overUnder?.['Over_1_5'] || null,
    });
  }
  if (ou.over25 >= 70) {
    allMarkets.push({
      id: 'over-25', category: 'goals',
      name: 'Goles totales — Más de 2.5',
      probability: ou.over25,
      odd: odds?.overUnder?.['Over_2_5'] || null,
    });
  }
  if (ou.over35 >= 70) {
    allMarkets.push({
      id: 'over-35', category: 'goals',
      name: 'Goles totales — Más de 3.5',
      probability: ou.over35,
      odd: odds?.overUnder?.['Over_3_5'] || null,
    });
  }
  // Exception: "menos de 3.5 goles" only if ≥90%
  if (ou.under35 >= 90) {
    allMarkets.push({
      id: 'under-35', category: 'goals',
      name: 'Goles totales — Menos de 3.5',
      probability: ou.under35,
      odd: odds?.overUnder?.['Under_3_5'] || null,
    });
  }

  // --- Corners totales ---
  const c = probabilities.corners;
  if (c.over85 >= 70) {
    allMarkets.push({
      id: 'corners-over-85', category: 'corners',
      name: 'Córners totales — Más de 8.5',
      probability: c.over85,
      odd: odds?.corners?.['Over_8_5'] || null,
    });
  }
  if (c.over95 >= 70) {
    allMarkets.push({
      id: 'corners-over-95', category: 'corners',
      name: 'Córners totales — Más de 9.5',
      probability: c.over95,
      odd: odds?.corners?.['Over_9_5'] || null,
    });
  }
  if (c.over105 >= 70) {
    allMarkets.push({
      id: 'corners-over-105', category: 'corners',
      name: 'Córners totales — Más de 10.5',
      probability: c.over105,
      odd: odds?.corners?.['Over_10_5'] || null,
    });
  }

  // --- Cards totales ---
  const ca = probabilities.cards;
  if (ca.over25 >= 70) {
    allMarkets.push({
      id: 'cards-over-25', category: 'cards',
      name: 'Tarjetas totales — Más de 2.5',
      probability: ca.over25,
      odd: odds?.cards?.['Over_2_5'] || null,
    });
  }
  if (ca.over35 >= 70) {
    allMarkets.push({
      id: 'cards-over-35', category: 'cards',
      name: 'Tarjetas totales — Más de 3.5',
      probability: ca.over35,
      odd: odds?.cards?.['Over_3_5'] || null,
    });
  }
  if (ca.over45 >= 70) {
    allMarkets.push({
      id: 'cards-over-45', category: 'cards',
      name: 'Tarjetas totales — Más de 4.5',
      probability: ca.over45,
      odd: odds?.cards?.['Over_4_5'] || null,
    });
  }

  // --- Goal timing by period (combined probability >85%) ---
  const gt = probabilities.goalTiming;
  if (gt?.combined) {
    // Find the single best period above 85% combined probability
    const bestPeriod = gt.combined
      .filter(p => p.probability > 85)
      .sort((a, b) => b.probability - a.probability)[0];
    if (bestPeriod) {
      allMarkets.push({
        id: 'timing-combined', category: 'timing',
        name: `Gol en periodo ${bestPeriod.period} min`,
        probability: bestPeriod.probability,
        odd: null,
      });
    }
  }

  // --- Per-team markets (from perTeam probabilities) ---
  const pt = probabilities.perTeam;
  if (pt) {
    // Home team corners
    const hc = pt.home?.corners;
    if (hc) {
      const entries = [
        { key: 'over05', label: '0.5', diff: 1 },
        { key: 'over15', label: '1.5', diff: 2 },
        { key: 'over25', label: '2.5', diff: 3 },
        { key: 'over35', label: '3.5', diff: 4 },
        { key: 'over45', label: '4.5', diff: 5 },
        { key: 'over55', label: '5.5', diff: 6 },
      ];
      for (const e of entries) {
        if (hc[e.key] >= 70) {
          allMarkets.push({
            id: `home-corners-over-${e.label}`, category: 'home-corners',
            name: `${homeName} — Más de ${e.label} córners`,
            probability: hc[e.key], odd: null, difficulty: e.diff,
          });
        }
      }
    }
    // Away team corners
    const ac = pt.away?.corners;
    if (ac) {
      const entries = [
        { key: 'over05', label: '0.5', diff: 1 },
        { key: 'over15', label: '1.5', diff: 2 },
        { key: 'over25', label: '2.5', diff: 3 },
        { key: 'over35', label: '3.5', diff: 4 },
        { key: 'over45', label: '4.5', diff: 5 },
        { key: 'over55', label: '5.5', diff: 6 },
      ];
      for (const e of entries) {
        if (ac[e.key] >= 70) {
          allMarkets.push({
            id: `away-corners-over-${e.label}`, category: 'away-corners',
            name: `${awayName} — Más de ${e.label} córners`,
            probability: ac[e.key], odd: null, difficulty: e.diff,
          });
        }
      }
    }
    // Home team cards
    const hca = pt.home?.cards;
    if (hca) {
      const entries = [
        { key: 'over05', label: '0.5', diff: 1 },
        { key: 'over15', label: '1.5', diff: 2 },
        { key: 'over25', label: '2.5', diff: 3 },
        { key: 'over35', label: '3.5', diff: 4 },
      ];
      for (const e of entries) {
        if (hca[e.key] >= 70) {
          allMarkets.push({
            id: `home-cards-over-${e.label}`, category: 'home-cards',
            name: `${homeName} — Más de ${e.label} tarjetas`,
            probability: hca[e.key], odd: null, difficulty: e.diff,
          });
        }
      }
    }
    // Away team cards
    const aca = pt.away?.cards;
    if (aca) {
      const entries = [
        { key: 'over05', label: '0.5', diff: 1 },
        { key: 'over15', label: '1.5', diff: 2 },
        { key: 'over25', label: '2.5', diff: 3 },
        { key: 'over35', label: '3.5', diff: 4 },
      ];
      for (const e of entries) {
        if (aca[e.key] >= 70) {
          allMarkets.push({
            id: `away-cards-over-${e.label}`, category: 'away-cards',
            name: `${awayName} — Más de ${e.label} tarjetas`,
            probability: aca[e.key], odd: null, difficulty: e.diff,
          });
        }
      }
    }
    // Home team goals
    const hg = pt.home?.goals;
    if (hg) {
      const entries = [
        { key: 'over05', label: '0.5', diff: 1 },
        { key: 'over15', label: '1.5', diff: 2 },
        { key: 'over25', label: '2.5', diff: 3 },
      ];
      for (const e of entries) {
        if (hg[e.key] >= 70) {
          allMarkets.push({
            id: `home-goals-over-${e.label}`, category: 'home-goals',
            name: `${homeName} — Más de ${e.label} goles`,
            probability: hg[e.key], odd: null, difficulty: e.diff,
          });
        }
      }
    }
    // Away team goals
    const ag = pt.away?.goals;
    if (ag) {
      const entries = [
        { key: 'over05', label: '0.5', diff: 1 },
        { key: 'over15', label: '1.5', diff: 2 },
        { key: 'over25', label: '2.5', diff: 3 },
      ];
      for (const e of entries) {
        if (ag[e.key] >= 70) {
          allMarkets.push({
            id: `away-goals-over-${e.label}`, category: 'away-goals',
            name: `${awayName} — Más de ${e.label} goles`,
            probability: ag[e.key], odd: null, difficulty: e.diff,
          });
        }
      }
    }
  }

  // --- Goleador ---
  if (playerHighlights?.scorers?.length > 0) {
    const topScorer = playerHighlights.scorers[0];
    const matchesWithGoal = topScorer.goals.filter(g => g >= 1).length;
    const totalMatches = topScorer.goals.length || 5;
    const scorerProb = Math.round((matchesWithGoal / totalMatches) * 100);
    if (scorerProb >= 70) {
      allMarkets.push({
        id: `scorer-${topScorer.id}`, category: 'scorer',
        name: `Goleador — ${topScorer.name}`,
        probability: scorerProb, odd: null,
      });
    }
  }

  // =========================================================================
  // Step 1: Deduplicate — one market per category, highest probability wins
  //         On tie, prefer the harder market (higher threshold)
  // =========================================================================
  const deduplicated = deduplicateByCategory(allMarkets);

  // =========================================================================
  // Step 2: Filter probable recommendations
  // Level 1: with real odds (ideal — allows combined odd calculation)
  // Level 2: probability-only (fallback for leagues without odds coverage)
  // =========================================================================
  const withOdds = deduplicated.filter(m => m.probability >= 70 && m.odd && m.odd > 1);
  withOdds.sort((a, b) => b.probability - a.probability);

  const withoutOdds = deduplicated.filter(m => m.probability >= 70);
  withoutOdds.sort((a, b) => b.probability - a.probability);

  // =========================================================================
  // Step 3: Build the combinada selection
  // =========================================================================
  let selected;
  let hasRealOdds = false;

  if (withOdds.length >= 2) {
    // Best case: real odds available
    selected = withOdds;
    hasRealOdds = true;
  } else if (withoutOdds.length >= 2) {
    // Fallback: use probability-only (no cuota combinada shown)
    selected = withoutOdds;
    hasRealOdds = false;
  } else {
    // Relax threshold to 65% — minimum useful recommendations
    const relaxed = deduplicated
      .filter(m => m.probability >= 65)
      .sort((a, b) => b.probability - a.probability);
    selected = relaxed;
    hasRealOdds = relaxed.some(m => m.odd && m.odd > 1);
  }

  // Limit to 8 selections max
  selected = selected.slice(0, 8);

  // Calculate combined odds (only when real odds available)
  const combinedOdd = selected.reduce((acc, m) => m.odd ? acc * m.odd : acc, 1);
  const combinedProbability = selected.length > 0
    ? selected.reduce((acc, m) => acc + m.probability, 0) / selected.length
    : 0;
  const highRisk = combinedProbability < 60;

  const effectiveThreshold = selected.length > 0
    ? Math.min(...selected.map(m => m.probability))
    : 70;

  return {
    selections: selected,
    combinedOdd: hasRealOdds ? +combinedOdd.toFixed(2) : null,
    combinedProbability: +combinedProbability.toFixed(1),
    highRisk,
    hasRealOdds,
    threshold: effectiveThreshold,
    totalMarkets: allMarkets.length,
    deduplicatedMarkets: deduplicated.length,
  };
}
