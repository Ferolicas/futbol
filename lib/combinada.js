// ===================== COMBINADA (ACCUMULATOR) LOGIC =====================

export function buildCombinada(probabilities, odds, playerHighlights) {
  const markets = [];

  // BTTS
  if (probabilities.btts >= 60) {
    markets.push({
      id: 'btts-yes',
      name: 'Ambos marcan — SÍ',
      probability: probabilities.btts,
      odd: odds?.btts?.yes || null,
    });
  }
  if (probabilities.bttsNo >= 60) {
    markets.push({
      id: 'btts-no',
      name: 'Ambos marcan — NO',
      probability: probabilities.bttsNo,
      odd: odds?.btts?.no || null,
    });
  }

  // Match Winner
  const { winner } = probabilities;
  if (winner.home >= 60) {
    markets.push({
      id: 'winner-home',
      name: 'Ganador — Local',
      probability: winner.home,
      odd: odds?.matchWinner?.home || null,
    });
  }
  if (winner.draw >= 60) {
    markets.push({
      id: 'winner-draw',
      name: 'Empate',
      probability: winner.draw,
      odd: odds?.matchWinner?.draw || null,
    });
  }
  if (winner.away >= 60) {
    markets.push({
      id: 'winner-away',
      name: 'Ganador — Visitante',
      probability: winner.away,
      odd: odds?.matchWinner?.away || null,
    });
  }

  // Over/Under Goals
  const ou = probabilities.overUnder;
  if (ou.over15 >= 60) {
    markets.push({
      id: 'over-15',
      name: 'Over 1.5 goles',
      probability: ou.over15,
      odd: odds?.overUnder?.['Over_1_5'] || null,
    });
  }
  if (ou.over25 >= 60) {
    markets.push({
      id: 'over-25',
      name: 'Over 2.5 goles',
      probability: ou.over25,
      odd: odds?.overUnder?.['Over_2_5'] || null,
    });
  }
  if (ou.over35 >= 60) {
    markets.push({
      id: 'over-35',
      name: 'Over 3.5 goles',
      probability: ou.over35,
      odd: odds?.overUnder?.['Over_3_5'] || null,
    });
  }
  if (ou.under25 >= 60) {
    markets.push({
      id: 'under-25',
      name: 'Under 2.5 goles',
      probability: ou.under25,
      odd: odds?.overUnder?.['Under_2_5'] || null,
    });
  }

  // Corners
  const c = probabilities.corners;
  if (c.over85 >= 60) {
    markets.push({
      id: 'corners-over-85',
      name: 'Over 8.5 córners',
      probability: c.over85,
      odd: null,
    });
  }
  if (c.over95 >= 60) {
    markets.push({
      id: 'corners-over-95',
      name: 'Over 9.5 córners',
      probability: c.over95,
      odd: null,
    });
  }
  if (c.over105 >= 60) {
    markets.push({
      id: 'corners-over-105',
      name: 'Over 10.5 córners',
      probability: c.over105,
      odd: null,
    });
  }

  // Cards
  const ca = probabilities.cards;
  if (ca.over25 >= 60) {
    markets.push({
      id: 'cards-over-25',
      name: 'Over 2.5 tarjetas',
      probability: ca.over25,
      odd: null,
    });
  }
  if (ca.over35 >= 60) {
    markets.push({
      id: 'cards-over-35',
      name: 'Over 3.5 tarjetas',
      probability: ca.over35,
      odd: null,
    });
  }

  // Goleador — top scorer from player highlights (3+ goals in 5 matches = 60%+ chance)
  if (playerHighlights?.scorers?.length > 0) {
    const topScorer = playerHighlights.scorers[0];
    const matchesWithGoal = topScorer.goals.filter(g => g >= 1).length;
    const totalMatches = topScorer.goals.length || 5;
    const scorerProb = Math.round((matchesWithGoal / totalMatches) * 100);
    if (scorerProb >= 60) {
      markets.push({
        id: `scorer-${topScorer.id}`,
        name: `Goleador — ${topScorer.name}`,
        probability: scorerProb,
        odd: null,
      });
    }
  }

  // Sort by probability descending
  markets.sort((a, b) => b.probability - a.probability);

  // Select: min probability 80%, then 75% if not enough, take 3-6
  let threshold = 80;
  let selected = markets.filter(m => m.probability >= threshold);

  if (selected.length < 3) {
    threshold = 75;
    selected = markets.filter(m => m.probability >= threshold);
  }

  if (selected.length < 3) {
    threshold = 70;
    selected = markets.filter(m => m.probability >= threshold);
  }

  // Limit to 6
  selected = selected.slice(0, 6);

  // Calculate combined odds and probability
  const combinedOdd = selected.reduce((acc, m) => m.odd ? acc * m.odd : acc, 1);
  const combinedProbability = selected.reduce((acc, m) => acc * (m.probability / 100), 1) * 100;
  const highRisk = combinedProbability < 60;

  return {
    selections: selected,
    combinedOdd: +combinedOdd.toFixed(2),
    combinedProbability: +combinedProbability.toFixed(1),
    highRisk,
    threshold,
    totalMarkets: markets.length,
  };
}
