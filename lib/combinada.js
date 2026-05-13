// ===================== COMBINADA (ACCUMULATOR) LOGIC =====================
//
// Builds the list of recommended markets for a fixture.
// Includes total-match markets, per-team markets and player props — but
// ONLY markets where there is a real cuota (odd > 1) from one of the
// authorized bookmakers. A market without a cuota is never recommended.
//
// Apuesta del Día (in app/dashboard/page.js) filters this list further by
// probability >= 90 and cuota >= 1.20.

const PROB_THRESHOLD = 70;   // baseline for any selection
const MIN_ODD        = 1.01; // anything ≤1.01 is meaningless

const clampProb = (p) => Math.max(5, Math.min(95, Math.round(p ?? 0)));

function normalizePlayerName(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Category definitions for deduplication.
 * Each category keeps only the single highest-probability market.
 * On tie, prefer the harder threshold (higher over-N).
 */
const TOTAL_CATEGORIES = {
  'total-goals':   ['total-over-15', 'total-over-25', 'total-over-35', 'total-under-35'],
  'total-corners': ['total-corners-85', 'total-corners-95', 'total-corners-105'],
  'total-cards':   ['total-cards-25', 'total-cards-35', 'total-cards-45'],
  'btts':          ['btts-yes', 'btts-no'],
  'winner':        ['winner-home', 'winner-draw', 'winner-away'],
};

// Difficulty rank within category — higher = harder. Used to break prob ties.
const DIFFICULTY = {
  'total-over-15': 1, 'total-over-25': 2, 'total-over-35': 3, 'total-under-35': 3,
  'total-corners-85': 1, 'total-corners-95': 2, 'total-corners-105': 3,
  'total-cards-25': 1, 'total-cards-35': 2, 'total-cards-45': 3,
};

function deduplicateByCategory(markets) {
  const idToCategory = {};
  for (const [cat, ids] of Object.entries(TOTAL_CATEGORIES)) {
    for (const id of ids) idToCategory[id] = cat;
  }

  const bestByCategory = {};
  const uncategorized  = [];

  for (const m of markets) {
    // Per-team and player markets carry their own m.category — use it directly.
    const cat = idToCategory[m.id] || m.category;
    if (!cat) { uncategorized.push(m); continue; }

    const existing = bestByCategory[cat];
    if (!existing ||
        m.probability > existing.probability ||
        (m.probability === existing.probability && (DIFFICULTY[m.id] || 0) > (DIFFICULTY[existing.id] || 0))) {
      bestByCategory[cat] = m;
    }
  }

  return [...Object.values(bestByCategory), ...uncategorized];
}

// Player markets aren't deduped against each other (a partido can recommend
// scorer for player A and also fouls for player A — two distinct apuestas).
// Each player-market combo is its own category implicitly.

export function buildCombinada(probabilities, odds, playerHighlights, teamNames) {
  if (!probabilities) {
    return { selections: [], combinedOdd: null, combinedProbability: 0, highRisk: false,
             hasRealOdds: false, threshold: PROB_THRESHOLD, totalMarkets: 0, deduplicatedMarkets: 0 };
  }

  const homeName = teamNames?.home || 'Local';
  const awayName = teamNames?.away || 'Visitante';
  const allMarkets = [];

  // Only add a market if there is a real cuota for it.
  const push = (m, oddVal) => {
    const odd = parseFloat(oddVal);
    if (!isFinite(odd) || odd <= MIN_ODD) return;
    allMarkets.push({ ...m, odd, probability: clampProb(m.probability) });
  };

  // ── BTTS (total) ──
  if (probabilities.btts != null) {
    push({ id: 'btts-yes', category: 'btts', scope: 'total', name: 'Total partido — Ambos marcan SÍ', probability: probabilities.btts },   odds?.btts?.yes);
    push({ id: 'btts-no',  category: 'btts', scope: 'total', name: 'Total partido — Ambos marcan NO', probability: probabilities.bttsNo }, odds?.btts?.no);
  }

  // ── Ganador del partido ──
  const w = probabilities.winner || {};
  push({ id: 'winner-home', category: 'winner', scope: 'team', team: 'home', name: `Ganador — ${homeName}`, probability: w.home }, odds?.matchWinner?.home);
  push({ id: 'winner-draw', category: 'winner', scope: 'total', name: 'Empate', probability: w.draw }, odds?.matchWinner?.draw);
  push({ id: 'winner-away', category: 'winner', scope: 'team', team: 'away', name: `Ganador — ${awayName}`, probability: w.away }, odds?.matchWinner?.away);

  // ── Goles totales del partido ──
  const ou = probabilities.overUnder || {};
  push({ id: 'total-over-15',  category: 'total-goals', scope: 'total', name: 'Total partido — Más de 1.5 goles',  probability: ou.over15  }, odds?.overUnder?.Over_1_5);
  push({ id: 'total-over-25',  category: 'total-goals', scope: 'total', name: 'Total partido — Más de 2.5 goles',  probability: ou.over25  }, odds?.overUnder?.Over_2_5);
  push({ id: 'total-over-35',  category: 'total-goals', scope: 'total', name: 'Total partido — Más de 3.5 goles',  probability: ou.over35  }, odds?.overUnder?.Over_3_5);
  push({ id: 'total-under-35', category: 'total-goals', scope: 'total', name: 'Total partido — Menos de 3.5 goles', probability: ou.under35 }, odds?.overUnder?.Under_3_5);

  // ── Córners totales ──
  const c = probabilities.corners || {};
  push({ id: 'total-corners-85',  category: 'total-corners', scope: 'total', name: 'Total partido — Más de 8.5 córners',  probability: c.over85  }, odds?.corners?.Over_8_5);
  push({ id: 'total-corners-95',  category: 'total-corners', scope: 'total', name: 'Total partido — Más de 9.5 córners',  probability: c.over95  }, odds?.corners?.Over_9_5);
  push({ id: 'total-corners-105', category: 'total-corners', scope: 'total', name: 'Total partido — Más de 10.5 córners', probability: c.over105 }, odds?.corners?.Over_10_5);

  // ── Tarjetas totales del partido ──
  const ca = probabilities.cards || {};
  push({ id: 'total-cards-25', category: 'total-cards', scope: 'total', name: 'Total partido — Más de 2.5 tarjetas', probability: ca.over25 }, odds?.cards?.Over_2_5);
  push({ id: 'total-cards-35', category: 'total-cards', scope: 'total', name: 'Total partido — Más de 3.5 tarjetas', probability: ca.over35 }, odds?.cards?.Over_3_5);
  push({ id: 'total-cards-45', category: 'total-cards', scope: 'total', name: 'Total partido — Más de 4.5 tarjetas', probability: ca.over45 }, odds?.cards?.Over_4_5);

  // ── Per-team: goles por equipo ──
  const pt = probabilities.perTeam || {};
  if (pt.home?.goals) {
    push({ id: 'home-goals-05', category: 'home-goals', scope: 'team', team: 'home', name: `Local (${homeName}) — Más de 0.5 goles`, probability: pt.home.goals.over05 }, odds?.homeGoals?.Over_0_5);
    push({ id: 'home-goals-15', category: 'home-goals', scope: 'team', team: 'home', name: `Local (${homeName}) — Más de 1.5 goles`, probability: pt.home.goals.over15 }, odds?.homeGoals?.Over_1_5);
    push({ id: 'home-goals-25', category: 'home-goals', scope: 'team', team: 'home', name: `Local (${homeName}) — Más de 2.5 goles`, probability: pt.home.goals.over25 }, odds?.homeGoals?.Over_2_5);
  }
  if (pt.away?.goals) {
    push({ id: 'away-goals-05', category: 'away-goals', scope: 'team', team: 'away', name: `Visitante (${awayName}) — Más de 0.5 goles`, probability: pt.away.goals.over05 }, odds?.awayGoals?.Over_0_5);
    push({ id: 'away-goals-15', category: 'away-goals', scope: 'team', team: 'away', name: `Visitante (${awayName}) — Más de 1.5 goles`, probability: pt.away.goals.over15 }, odds?.awayGoals?.Over_1_5);
    push({ id: 'away-goals-25', category: 'away-goals', scope: 'team', team: 'away', name: `Visitante (${awayName}) — Más de 2.5 goles`, probability: pt.away.goals.over25 }, odds?.awayGoals?.Over_2_5);
  }

  // ── Per-team: córners por equipo ──
  if (pt.home?.corners) {
    push({ id: 'home-corners-35', category: 'home-corners', scope: 'team', team: 'home', name: `Local (${homeName}) — Más de 3.5 córners`, probability: pt.home.corners.over35 }, odds?.homeCorners?.Over_3_5);
    push({ id: 'home-corners-45', category: 'home-corners', scope: 'team', team: 'home', name: `Local (${homeName}) — Más de 4.5 córners`, probability: pt.home.corners.over45 }, odds?.homeCorners?.Over_4_5);
    push({ id: 'home-corners-55', category: 'home-corners', scope: 'team', team: 'home', name: `Local (${homeName}) — Más de 5.5 córners`, probability: pt.home.corners.over55 }, odds?.homeCorners?.Over_5_5);
  }
  if (pt.away?.corners) {
    push({ id: 'away-corners-35', category: 'away-corners', scope: 'team', team: 'away', name: `Visitante (${awayName}) — Más de 3.5 córners`, probability: pt.away.corners.over35 }, odds?.awayCorners?.Over_3_5);
    push({ id: 'away-corners-45', category: 'away-corners', scope: 'team', team: 'away', name: `Visitante (${awayName}) — Más de 4.5 córners`, probability: pt.away.corners.over45 }, odds?.awayCorners?.Over_4_5);
    push({ id: 'away-corners-55', category: 'away-corners', scope: 'team', team: 'away', name: `Visitante (${awayName}) — Más de 5.5 córners`, probability: pt.away.corners.over55 }, odds?.awayCorners?.Over_5_5);
  }

  // ── Per-team: tarjetas por equipo ──
  if (pt.home?.cards) {
    push({ id: 'home-cards-05', category: 'home-cards', scope: 'team', team: 'home', name: `Local (${homeName}) — Más de 0.5 tarjetas`, probability: pt.home.cards.over05 }, odds?.homeCards?.Over_0_5);
    push({ id: 'home-cards-15', category: 'home-cards', scope: 'team', team: 'home', name: `Local (${homeName}) — Más de 1.5 tarjetas`, probability: pt.home.cards.over15 }, odds?.homeCards?.Over_1_5);
    push({ id: 'home-cards-25', category: 'home-cards', scope: 'team', team: 'home', name: `Local (${homeName}) — Más de 2.5 tarjetas`, probability: pt.home.cards.over25 }, odds?.homeCards?.Over_2_5);
  }
  if (pt.away?.cards) {
    push({ id: 'away-cards-05', category: 'away-cards', scope: 'team', team: 'away', name: `Visitante (${awayName}) — Más de 0.5 tarjetas`, probability: pt.away.cards.over05 }, odds?.awayCards?.Over_0_5);
    push({ id: 'away-cards-15', category: 'away-cards', scope: 'team', team: 'away', name: `Visitante (${awayName}) — Más de 1.5 tarjetas`, probability: pt.away.cards.over15 }, odds?.awayCards?.Over_1_5);
    push({ id: 'away-cards-25', category: 'away-cards', scope: 'team', team: 'away', name: `Visitante (${awayName}) — Más de 2.5 tarjetas`, probability: pt.away.cards.over25 }, odds?.awayCards?.Over_2_5);
  }

  // ── Player markets ──
  // Probability is computed inline from playerHighlights as frequency:
  //   matches with ≥1 event of that type / total matches sampled.
  // Cuota is looked up by normalized player name in odds.players.{family}.
  const ph = playerHighlights || {};
  const lookupPlayerOdd = (family, playerName) => {
    const norm = normalizePlayerName(playerName);
    if (!norm) return null;
    const bucket = odds?.players?.[family];
    if (!bucket) return null;
    if (bucket[norm]) return bucket[norm];
    // Fuzzy: surname-only match
    const lastName = norm.split(' ').pop();
    if (lastName && lastName.length >= 3) {
      for (const [k, v] of Object.entries(bucket)) {
        if (k.endsWith(' ' + lastName) || k === lastName) return v;
      }
    }
    return null;
  };

  const playerFreq = (events) => {
    if (!Array.isArray(events) || events.length === 0) return 0;
    const hits = events.filter(e => (e || 0) >= 1).length;
    return clampProb(Math.round((hits / events.length) * 100));
  };

  (ph.scorers || []).forEach(p => {
    const prob = playerFreq(p.goals);
    const odd  = lookupPlayerOdd('scorer', p.name);
    push({ id: `scorer-${p.id}`, category: `scorer-${p.id}`, scope: 'player',
           playerId: p.id, playerName: p.name, team: p.teamName,
           name: `${p.name} — Anotar un gol`, probability: prob }, odd);
  });

  (ph.shooters || []).forEach(p => {
    const prob = playerFreq(p.shotsOnGoal);
    const odd  = lookupPlayerOdd('shots', p.name);
    push({ id: `shots-${p.id}`, category: `shots-${p.id}`, scope: 'player',
           playerId: p.id, playerName: p.name, team: p.teamName,
           name: `${p.name} — Remate al arco`, probability: prob }, odd);
  });

  (ph.foulers || []).forEach(p => {
    const prob = playerFreq(p.fouls);
    const odd  = lookupPlayerOdd('fouls', p.name);
    push({ id: `fouls-${p.id}`, category: `fouls-${p.id}`, scope: 'player',
           playerId: p.id, playerName: p.name, team: p.teamName,
           name: `${p.name} — Cometer una falta`, probability: prob }, odd);
  });

  (ph.bookers || []).forEach(p => {
    const prob = playerFreq(p.yellows);
    const odd  = lookupPlayerOdd('booked', p.name);
    push({ id: `booked-${p.id}`, category: `booked-${p.id}`, scope: 'player',
           playerId: p.id, playerName: p.name, team: p.teamName,
           name: `${p.name} — Recibir tarjeta amarilla`, probability: prob }, odd);
  });

  // ── Dedup, sort, filter ──
  const deduplicated = deduplicateByCategory(allMarkets);
  const selected = deduplicated
    .filter(m => m.probability >= PROB_THRESHOLD && m.odd > MIN_ODD)
    .sort((a, b) => b.probability - a.probability);

  if (selected.length === 0) {
    return {
      selections: [], combinedOdd: null, combinedProbability: 0,
      highRisk: false, hasRealOdds: false, threshold: PROB_THRESHOLD,
      totalMarkets: allMarkets.length, deduplicatedMarkets: deduplicated.length,
    };
  }

  const combinedOdd         = selected.reduce((acc, m) => acc * m.odd, 1);
  const combinedProbability = selected.reduce((acc, m) => acc + m.probability, 0) / selected.length;
  const effectiveThreshold  = Math.min(...selected.map(m => m.probability));

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
