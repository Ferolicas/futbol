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
  // ── Nuevos (cache_version 8) — el bookmaker ofrece varias lineas; dedup
  // mantiene la de mejor probabilidad. Las ids exactas tienen sufijo dinamico
  // (over11_5, over13_5, etc.) — el matcher de categoria usa el prefijo via
  // m.category, no la lista enumerada.
  'winner-1H':     [],
  'winner-2H':     [],
  'goals-1H':      [],
  'goals-2H':      [],
  'shots-total':   [],
  'sot-total':     [],
  'fouls-total':   [],
  'corners-1H':    [],
  'corners-2H':    [],
  'most-corners-full':  [],
  'most-corners-1H':    [],
  'most-corners-2H':    [],
  'most-shots-full':    [],
  'most-shots-1H':      [],
  'most-shots-2H':      [],
  'most-fouls-full':    [],
  'most-fouls-1H':      [],
  'most-fouls-2H':      [],
  'asian-handicap':     [],
  'asian-handicap-1H':  [],
  'asian-handicap-2H':  [],
  // Per-team nuevos
  'home-shots':         [],
  'away-shots':         [],
  'home-sot':           [],
  'away-sot':           [],
  'home-fouls':         [],
  'away-fouls':         [],
  'home-goals-1H':      [],
  'away-goals-1H':      [],
  'home-goals-2H':      [],
  'away-goals-2H':      [],
};

// Difficulty rank within category — higher = harder. Used to break prob ties.
// Para los mercados con linea dinamica usamos la _line del mercado en runtime.
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

  // Player anytime: ≥1 evento en N partidos. Reusada por scorer/assist/booked.
  const playerFreq = (events) => {
    if (!Array.isArray(events) || events.length === 0) return 0;
    const hits = events.filter(e => (e || 0) >= 1).length;
    return clampProb(Math.round((hits / events.length) * 100));
  };

  // Player freq con threshold variable. Linea L.5 del bookmaker equivale a
  // "≥ ceil(L.5)" eventos. Ej: linea 1.5 → threshold 2 (≥2 faltas/tiros).
  const playerFreqAtLeast = (events, threshold) => {
    if (!Array.isArray(events) || events.length === 0) return 0;
    const t = Math.max(1, threshold);
    const hits = events.filter(e => (e || 0) >= t).length;
    return clampProb(Math.round((hits / events.length) * 100));
  };

  // Dado el histograma del jugador y el mapa de cuotas { "0.5": odd, "1.5": odd, ... }
  // de Bet365, elige la LINEA optima maximizando expected value (EV+):
  //   EV(line) = freq(line) * (odd - 1)
  // sujeto a freq >= PROB_THRESHOLD (70). Si ninguna linea cumple → null.
  //
  // Lectura del trade-off:
  //   L0.5 cuota 1.25 freq 90% → EV = 90*0.25 = 22.5
  //   L1.5 cuota 2.10 freq 80% → EV = 80*1.10 = 88.0   ← seleccionado
  //   L2.5 cuota 4.30 freq 60% → descartado (freq<70)
  const lookupPlayerOddsByLine = (family, playerName) => {
    const norm = normalizePlayerName(playerName);
    if (!norm) return null;
    const bucket = odds?.players?.[family];
    if (!bucket || typeof bucket !== 'object') return null;
    if (bucket[norm] && typeof bucket[norm] === 'object') return bucket[norm];
    // Fuzzy match (mismo patron que lookupPlayerOdd)
    const lastName = norm.split(' ').pop();
    if (lastName && lastName.length >= 3) {
      for (const [k, v] of Object.entries(bucket)) {
        if (typeof v !== 'object') continue;
        if (k.endsWith(' ' + lastName) || k === lastName) return v;
      }
    }
    return null;
  };

  const selectBestPlayerLine = (events, oddsByLine) => {
    if (!oddsByLine || !Array.isArray(events) || events.length === 0) return null;
    const candidates = [];
    for (const [lineStr, oddRaw] of Object.entries(oddsByLine)) {
      const line = parseFloat(lineStr);
      const odd = parseFloat(oddRaw);
      if (!Number.isFinite(line) || !Number.isFinite(odd) || odd <= MIN_ODD) continue;
      const threshold = Math.ceil(line);    // 0.5 → 1, 1.5 → 2, 2.5 → 3
      const freq = playerFreqAtLeast(events, threshold);
      if (freq < PROB_THRESHOLD) continue;
      candidates.push({ line, odd, freq, ev: freq * (odd - 1) });
    }
    if (candidates.length === 0) return null;
    // Prioriza mayor EV (value-aware); en empate, mayor freq (confianza).
    candidates.sort((a, b) => b.ev - a.ev || b.freq - a.freq);
    return candidates[0];
  };

  // ── Scorer (anytime, sin lineas) ──
  (ph.scorers || []).forEach(p => {
    const prob = playerFreq(p.goals);
    const odd  = lookupPlayerOdd('scorer', p.name);
    push({ id: `scorer-${p.id}`, category: `scorer-${p.id}`, scope: 'player',
           playerId: p.id, playerName: p.name, team: p.teamName,
           name: `${p.name} — Anotar un gol`, probability: prob }, odd);
  });

  // ── Assists (anytime, sin lineas) ──
  // Movido aqui desde el bloque legacy de player markets — antes estaba
  // mas abajo con playerShots, ahora va junto a los otros anytime.
  (ph.assisters || []).forEach(p => {
    const prob = playerFreq(p.assists);
    const odd  = lookupPlayerOdd('assists', p.name);
    push({ id: `assists-${p.id}`, category: `assists-${p.id}`, scope: 'player',
           playerId: p.id, playerName: p.name, team: p.teamName,
           name: `${p.name} — Dar una asistencia`, probability: prob }, odd);
  });

  // ── Booked (anytime, sin lineas) ──
  (ph.bookers || []).forEach(p => {
    const prob = playerFreq(p.yellows);
    const odd  = lookupPlayerOdd('booked', p.name);
    push({ id: `booked-${p.id}`, category: `booked-${p.id}`, scope: 'player',
           playerId: p.id, playerName: p.name, team: p.teamName,
           name: `${p.name} — Recibir tarjeta amarilla`, probability: prob }, odd);
  });

  // ── Tiros a puerta — linea optima por EV ──
  // shotsOn ↔ p.shotsOnGoal (histograma de shots on target).
  (ph.shooters || []).forEach(p => {
    const oddsByLine = lookupPlayerOddsByLine('shotsOn', p.name);
    const best = selectBestPlayerLine(p.shotsOnGoal, oddsByLine);
    if (!best) {
      // Fallback: no hay linea que cumpla threshold o no hay cuotas.
      // Empuja igualmente con prob anytime y SIN cuota — push() lo descarta
      // por falta de odd; el modelo queda registrado para diagnostico.
      const probAnytime = playerFreq(p.shotsOnGoal);
      push({ id: `shotsOn-${p.id}`, category: `shotsOn-${p.id}`, scope: 'player',
             playerId: p.id, playerName: p.name, team: p.teamName,
             name: `${p.name} — Remate a puerta`, probability: probAnytime }, null);
      return;
    }
    const threshold = Math.ceil(best.line);
    const label = threshold === 1
      ? `${p.name} — Remate a puerta`
      : `${p.name} — ${threshold}+ remates a puerta`;
    push({ id: `shotsOn-${p.id}`, category: `shotsOn-${p.id}`, scope: 'player',
           playerId: p.id, playerName: p.name, team: p.teamName,
           name: label, probability: best.freq, _line: best.line }, best.odd);
  });

  // ── Tiros totales — linea optima por EV ──
  // shotsTotal ↔ p.shotsTotal (histograma de total shots).
  (ph.shotsTotalists || []).forEach(p => {
    const oddsByLine = lookupPlayerOddsByLine('shotsTotal', p.name);
    const best = selectBestPlayerLine(p.shotsTotal, oddsByLine);
    if (!best) {
      const probAnytime = playerFreq(p.shotsTotal);
      push({ id: `shotsTotal-${p.id}`, category: `shotsTotal-${p.id}`, scope: 'player',
             playerId: p.id, playerName: p.name, team: p.teamName,
             name: `${p.name} — Hacer un tiro`, probability: probAnytime }, null);
      return;
    }
    const threshold = Math.ceil(best.line);
    const label = threshold === 1
      ? `${p.name} — Hacer un tiro`
      : `${p.name} — ${threshold}+ tiros`;
    push({ id: `shotsTotal-${p.id}`, category: `shotsTotal-${p.id}`, scope: 'player',
           playerId: p.id, playerName: p.name, team: p.teamName,
           name: label, probability: best.freq, _line: best.line }, best.odd);
  });

  // ── Faltas — linea optima por EV ──
  // fouls ↔ p.fouls (histograma de fouls committed).
  (ph.foulers || []).forEach(p => {
    const oddsByLine = lookupPlayerOddsByLine('fouls', p.name);
    const best = selectBestPlayerLine(p.fouls, oddsByLine);
    if (!best) {
      const probAnytime = playerFreq(p.fouls);
      push({ id: `fouls-${p.id}`, category: `fouls-${p.id}`, scope: 'player',
             playerId: p.id, playerName: p.name, team: p.teamName,
             name: `${p.name} — Cometer una falta`, probability: probAnytime }, null);
      return;
    }
    const threshold = Math.ceil(best.line);
    const label = threshold === 1
      ? `${p.name} — Cometer una falta`
      : `${p.name} — ${threshold}+ faltas`;
    push({ id: `fouls-${p.id}`, category: `fouls-${p.id}`, scope: 'player',
           playerId: p.id, playerName: p.name, team: p.teamName,
           name: label, probability: best.freq, _line: best.line }, best.odd);
  });

  // (assisters, shotsTotalists, shooters y foulers ya se procesaron arriba
  //  en los bloques de "linea optima por EV" — no se duplican aqui.)

  // ──────────────────────────────────────────────────────────────────────────
  // MERCADOS A NIVEL PARTIDO Y EQUIPO (nuevos, cache_version 8)
  //
  // Cuando el modelo ofrece varias lineas (over10_5, over11_5, over12_5...),
  // se hace un push por cada una con cuota disponible; dedup por categoria
  // se queda con la mejor. iterOuLines() abstrae el iterado.
  // ──────────────────────────────────────────────────────────────────────────

  // Convierte "over11_5" → 11.5 (numero) para mostrar al usuario
  const lineFromKey = (key) => {
    const m = (key || '').match(/^over(\d+)(?:_(\d+))?$/i);
    if (!m) return null;
    return parseFloat(`${m[1]}.${m[2] || '0'}`);
  };

  // Para mercados over/under con lineas dinamicas:
  // probs = { _lines, over11_5: 78, over12_5: 65, ... }
  // odds  = { Over_11_5: 1.85, Under_11_5: 1.95, Over_12_5: 2.10, ... }
  const iterOuLines = (probs, odds, category, namePrefix) => {
    if (!probs || !odds) return;
    for (const key of Object.keys(probs)) {
      if (key.startsWith('_')) continue;
      if (!key.startsWith('over')) continue;
      const line = lineFromKey(key);
      if (line == null) continue;
      const oddKey = `Over_${String(line).replace('.', '_')}`;
      const oddVal = odds[oddKey];
      const id = `${category}-${String(line).replace('.', '-')}`;
      push({ id, category, scope: 'total', name: `${namePrefix} — Más de ${line}`,
             probability: probs[key], _line: line }, oddVal);
    }
  };

  // Tiros totales
  iterOuLines(probabilities.shots, odds?.shots, 'shots-total', 'Total partido — Tiros');
  // Tiros a puerta totales
  iterOuLines(probabilities.sot, odds?.sot, 'sot-total', 'Total partido — Tiros a puerta');
  // Faltas totales
  iterOuLines(probabilities.fouls, odds?.fouls, 'fouls-total', 'Total partido — Faltas');

  // Tiros per-team
  if (probabilities.perTeamShots?.home) {
    iterOuLines(probabilities.perTeamShots.home, odds?.homeShots, 'home-shots', `Local (${homeName}) — Tiros`);
  }
  if (probabilities.perTeamShots?.away) {
    iterOuLines(probabilities.perTeamShots.away, odds?.awayShots, 'away-shots', `Visitante (${awayName}) — Tiros`);
  }
  // Faltas per-team
  if (probabilities.perTeamFouls?.home) {
    iterOuLines(probabilities.perTeamFouls.home, odds?.homeFouls, 'home-fouls', `Local (${homeName}) — Faltas`);
  }
  if (probabilities.perTeamFouls?.away) {
    iterOuLines(probabilities.perTeamFouls.away, odds?.awayFouls, 'away-fouls', `Visitante (${awayName}) — Faltas`);
  }
  // Shots on target per-team
  if (probabilities.perTeamShots?.home && odds?.homeSot) {
    iterOuLines(probabilities.perTeamShots.home, odds.homeSot, 'home-sot', `Local (${homeName}) — Tiros a puerta`);
  }
  if (probabilities.perTeamShots?.away && odds?.awaySot) {
    iterOuLines(probabilities.perTeamShots.away, odds.awaySot, 'away-sot', `Visitante (${awayName}) — Tiros a puerta`);
  }

  // Goles 1ª/2ª parte (over/under)
  const halfGoals = probabilities.halfGoals;
  if (halfGoals?.firstHalf && odds?.goals1H) {
    push({ id: 'goals-1H-05', category: 'goals-1H', scope: 'total', name: '1ª Parte — Más de 0.5 goles', probability: halfGoals.firstHalf.over05 }, odds.goals1H.Over_0_5);
    push({ id: 'goals-1H-15', category: 'goals-1H', scope: 'total', name: '1ª Parte — Más de 1.5 goles', probability: halfGoals.firstHalf.over15 }, odds.goals1H.Over_1_5);
    push({ id: 'goals-1H-25', category: 'goals-1H', scope: 'total', name: '1ª Parte — Más de 2.5 goles', probability: halfGoals.firstHalf.over25 }, odds.goals1H.Over_2_5);
  }
  if (halfGoals?.secondHalf && odds?.goals2H) {
    push({ id: 'goals-2H-05', category: 'goals-2H', scope: 'total', name: '2ª Parte — Más de 0.5 goles', probability: halfGoals.secondHalf.over05 }, odds.goals2H.Over_0_5);
    push({ id: 'goals-2H-15', category: 'goals-2H', scope: 'total', name: '2ª Parte — Más de 1.5 goles', probability: halfGoals.secondHalf.over15 }, odds.goals2H.Over_1_5);
    push({ id: 'goals-2H-25', category: 'goals-2H', scope: 'total', name: '2ª Parte — Más de 2.5 goles', probability: halfGoals.secondHalf.over25 }, odds.goals2H.Over_2_5);
  }

  // 1X2 por mitad
  const hw = probabilities.halfWinner || {};
  if (hw.firstHalf && odds?.winner1H) {
    push({ id: 'winner-1H-home', category: 'winner-1H', scope: 'team', team: 'home', name: `1ª Parte — Gana ${homeName}`, probability: hw.firstHalf.home }, odds.winner1H.home);
    push({ id: 'winner-1H-draw', category: 'winner-1H', scope: 'total', name: '1ª Parte — Empate', probability: hw.firstHalf.draw }, odds.winner1H.draw);
    push({ id: 'winner-1H-away', category: 'winner-1H', scope: 'team', team: 'away', name: `1ª Parte — Gana ${awayName}`, probability: hw.firstHalf.away }, odds.winner1H.away);
  }
  if (hw.secondHalf && odds?.winner2H) {
    push({ id: 'winner-2H-home', category: 'winner-2H', scope: 'team', team: 'home', name: `2ª Parte — Gana ${homeName}`, probability: hw.secondHalf.home }, odds.winner2H.home);
    push({ id: 'winner-2H-draw', category: 'winner-2H', scope: 'total', name: '2ª Parte — Empate', probability: hw.secondHalf.draw }, odds.winner2H.draw);
    push({ id: 'winner-2H-away', category: 'winner-2H', scope: 'team', team: 'away', name: `2ª Parte — Gana ${awayName}`, probability: hw.secondHalf.away }, odds.winner2H.away);
  }

  // Goles per-team por mitad
  const pthg = probabilities.perTeamHalfGoals;
  if (pthg?.home?.firstHalf && odds?.homeGoals1H) {
    push({ id: 'home-goals-1H-05', category: 'home-goals-1H', scope: 'team', team: 'home', name: `1ª Parte — ${homeName} marca`, probability: pthg.home.firstHalf.over05 }, odds.homeGoals1H.Over_0_5);
  }
  if (pthg?.away?.firstHalf && odds?.awayGoals1H) {
    push({ id: 'away-goals-1H-05', category: 'away-goals-1H', scope: 'team', team: 'away', name: `1ª Parte — ${awayName} marca`, probability: pthg.away.firstHalf.over05 }, odds.awayGoals1H.Over_0_5);
  }
  if (pthg?.home?.secondHalf && odds?.homeGoals2H) {
    push({ id: 'home-goals-2H-05', category: 'home-goals-2H', scope: 'team', team: 'home', name: `2ª Parte — ${homeName} marca`, probability: pthg.home.secondHalf.over05 }, odds.homeGoals2H.Over_0_5);
  }
  if (pthg?.away?.secondHalf && odds?.awayGoals2H) {
    push({ id: 'away-goals-2H-05', category: 'away-goals-2H', scope: 'team', team: 'away', name: `2ª Parte — ${awayName} marca`, probability: pthg.away.secondHalf.over05 }, odds.awayGoals2H.Over_0_5);
  }

  // Asian Handicap — iterar lineas que ofrece el bookmaker
  const ahProbs = probabilities.asianHandicap;
  if (ahProbs && odds?.asianHandicap) {
    for (const oddKey of Object.keys(odds.asianHandicap)) {
      // oddKey: "home_m1_5", "away_p0_5", etc.
      const m = oddKey.match(/^(home|away)_([mp])(\d+(?:_\d+)?)$/);
      if (!m) continue;
      const side = m[1];
      const sign = m[2] === 'm' ? -1 : 1;
      const lineNum = sign * parseFloat(m[3].replace('_', '.'));
      const probKey = `h${oddKey.slice(oddKey.indexOf('_') + 1)}`;
      const prob = ahProbs[side]?.[probKey];
      if (prob == null) continue;
      const teamName = side === 'home' ? homeName : awayName;
      push({
        id: `ah-${side}-${oddKey}`, category: 'asian-handicap', scope: 'team', team: side,
        name: `Handicap ${teamName} ${lineNum > 0 ? '+' : ''}${lineNum}`,
        probability: prob, _line: lineNum,
      }, odds.asianHandicap[oddKey]);
    }
  }

  // Corners totales por mitad
  if (probabilities.corners && odds?.corners1H) {
    // Reutilizamos la corners distribution con la mitad de λ
    const c = probabilities.corners;
    push({ id: 'corners-1H-35', category: 'corners-1H', scope: 'total', name: '1ª Parte — Más de 3.5 córners', probability: c.over85 }, odds.corners1H.Over_3_5);
    push({ id: 'corners-1H-45', category: 'corners-1H', scope: 'total', name: '1ª Parte — Más de 4.5 córners', probability: c.over95 }, odds.corners1H.Over_4_5);
  }
  if (probabilities.corners && odds?.corners2H) {
    const c = probabilities.corners;
    push({ id: 'corners-2H-45', category: 'corners-2H', scope: 'total', name: '2ª Parte — Más de 4.5 córners', probability: c.over95 }, odds.corners2H.Over_4_5);
    push({ id: 'corners-2H-55', category: 'corners-2H', scope: 'total', name: '2ª Parte — Más de 5.5 córners', probability: c.over105 }, odds.corners2H.Over_5_5);
  }

  // Equipo con más córners (full / 1H / 2H)
  const mc = probabilities.mostCorners;
  if (mc?.fullMatch && odds?.corners1x2) {
    push({ id: 'most-corners-full-home', category: 'most-corners-full', scope: 'team', team: 'home', name: `Más córners — ${homeName}`, probability: mc.fullMatch.home }, odds.corners1x2.home);
    push({ id: 'most-corners-full-draw', category: 'most-corners-full', scope: 'total', name: 'Mismos córners — Empate', probability: mc.fullMatch.draw }, odds.corners1x2.draw);
    push({ id: 'most-corners-full-away', category: 'most-corners-full', scope: 'team', team: 'away', name: `Más córners — ${awayName}`, probability: mc.fullMatch.away }, odds.corners1x2.away);
  }
  if (mc?.firstHalf && odds?.corners1x21H) {
    push({ id: 'most-corners-1H-home', category: 'most-corners-1H', scope: 'team', team: 'home', name: `1ª Parte — Más córners ${homeName}`, probability: mc.firstHalf.home }, odds.corners1x21H.home);
    push({ id: 'most-corners-1H-draw', category: 'most-corners-1H', scope: 'total', name: '1ª Parte — Empate de córners', probability: mc.firstHalf.draw }, odds.corners1x21H.draw);
    push({ id: 'most-corners-1H-away', category: 'most-corners-1H', scope: 'team', team: 'away', name: `1ª Parte — Más córners ${awayName}`, probability: mc.firstHalf.away }, odds.corners1x21H.away);
  }
  if (mc?.secondHalf && odds?.corners1x22H) {
    push({ id: 'most-corners-2H-home', category: 'most-corners-2H', scope: 'team', team: 'home', name: `2ª Parte — Más córners ${homeName}`, probability: mc.secondHalf.home }, odds.corners1x22H.home);
    push({ id: 'most-corners-2H-draw', category: 'most-corners-2H', scope: 'total', name: '2ª Parte — Empate de córners', probability: mc.secondHalf.draw }, odds.corners1x22H.draw);
    push({ id: 'most-corners-2H-away', category: 'most-corners-2H', scope: 'team', team: 'away', name: `2ª Parte — Más córners ${awayName}`, probability: mc.secondHalf.away }, odds.corners1x22H.away);
  }

  // Equipo con más tiros (solo full match — los bookmakers no ofrecen por mitad).
  // 1H/2H se push-ean SIN cuota (push() los descartara), el modelo queda listo
  // para cuando un bookmaker los publique.
  const ms = probabilities.mostShots;
  if (ms?.fullMatch && odds?.shots1x2) {
    push({ id: 'most-shots-full-home', category: 'most-shots-full', scope: 'team', team: 'home', name: `Más tiros — ${homeName}`, probability: ms.fullMatch.home }, odds.shots1x2.home);
    push({ id: 'most-shots-full-draw', category: 'most-shots-full', scope: 'total', name: 'Mismos tiros — Empate', probability: ms.fullMatch.draw }, odds.shots1x2.draw);
    push({ id: 'most-shots-full-away', category: 'most-shots-full', scope: 'team', team: 'away', name: `Más tiros — ${awayName}`, probability: ms.fullMatch.away }, odds.shots1x2.away);
  }

  // Equipo con más faltas (full match — 1xbet/Betano)
  const mf = probabilities.mostFouls;
  if (mf?.fullMatch && odds?.fouls1x2) {
    push({ id: 'most-fouls-full-home', category: 'most-fouls-full', scope: 'team', team: 'home', name: `Más faltas — ${homeName}`, probability: mf.fullMatch.home }, odds.fouls1x2.home);
    push({ id: 'most-fouls-full-draw', category: 'most-fouls-full', scope: 'total', name: 'Mismas faltas — Empate', probability: mf.fullMatch.draw }, odds.fouls1x2.draw);
    push({ id: 'most-fouls-full-away', category: 'most-fouls-full', scope: 'team', team: 'away', name: `Más faltas — ${awayName}`, probability: mf.fullMatch.away }, odds.fouls1x2.away);
  }

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
