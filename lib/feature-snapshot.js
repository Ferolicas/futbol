// ────────────────────────────────────────────────────────────────────────
// Builder PURO del vector de features de contexto (point-in-time).
//
// La MISMA función se usa en dos caminos para garantizar paridad train/score:
//   - En vivo: analyzeMatch() → _savePrediction() guarda el snapshot.
//   - Histórico: scripts/backfill-features.js reconstruye un `analysis`
//     equivalente con datos del MOMENTO del partido y llama aquí.
//
// Regla de oro: solo lee información disponible ANTES del saque. La causalidad
// (remates/posesión/xG) y el ADN salen de los ÚLTIMOS 5 PREVIOS, nunca del
// propio partido (eso es el resultado → actuals_full).
//
// Todo es null-safe: si un input falta, el feature sale null + su flag de
// disponibilidad, y el meta-modelo lo trata como "dato ausente" sin descartar
// la fila.
// ────────────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

const r3 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1000) / 1000);
const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
const avg = (arr) => {
  const xs = (arr || []).filter((v) => v != null && isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};
const rate = (arr, pred) => {
  // filtrar solo null/undefined — NO usar filter(Boolean), que descartaría los
  // `false` de arrays booleanos (btts/scored/cleanSheet) y sesgaría la tasa.
  const xs = (arr || []).filter((v) => v != null);
  return xs.length ? xs.filter(pred).length / xs.length : null;
};

// Clasifica league.round → tipo de fase. Sirve para que el meta-modelo pese
// distinto grupos / eliminatorias / final / ida-vuelta.
function parseRound(round) {
  const r = String(round || '').toLowerCase();
  const out = { raw: round || null, type: 'regular', isKnockout: false, isTwoLeg: false, isFinal: false };
  if (/2nd leg|second leg|vuelta/.test(r)) out.isTwoLeg = true;
  if (/1st leg|first leg|ida/.test(r)) out.isTwoLeg = true;
  if (/\bfinal\b/.test(r) && !/semi|quarter|1\/8|round of/.test(r)) { out.type = 'final'; out.isFinal = true; out.isKnockout = true; }
  else if (/semi/.test(r)) { out.type = 'semi'; out.isKnockout = true; }
  else if (/quarter|1\/4/.test(r)) { out.type = 'quarter'; out.isKnockout = true; }
  else if (/round of 16|1\/8|eighth/.test(r)) { out.type = 'round16'; out.isKnockout = true; }
  else if (/group/.test(r)) { out.type = 'group'; }
  else if (/qualif|preliminary|play-?off/.test(r)) { out.type = 'qualifying'; out.isKnockout = true; }
  return out;
}

// Número de jornada si el round es "Regular Season - 32" → 32.
function roundNumber(round) {
  const m = String(round || '').match(/-\s*(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

// Probabilidad implícita des-margenada del 1X2 (quita el overround de la casa).
function impliedFrom1x2(mw) {
  if (!mw) return { available: false, home: null, draw: null, away: null, overround: null };
  const inv = {};
  let sum = 0;
  for (const k of ['home', 'draw', 'away']) {
    const o = Number(mw[k]);
    if (isFinite(o) && o > 1) { inv[k] = 1 / o; sum += inv[k]; }
  }
  if (sum <= 0) return { available: false, home: null, draw: null, away: null, overround: null };
  return {
    available: true,
    home: r3(inv.home != null ? inv.home / sum : null),
    draw: r3(inv.draw != null ? inv.draw / sum : null),
    away: r3(inv.away != null ? inv.away / sum : null),
    overround: r3(sum),
  };
}

// Forma desde los últimos 5 (más reciente primero). ppg + racha + medias.
function formFromLast5(last5) {
  const ms = (last5 || []).map((m) => m._enriched).filter(Boolean);
  if (ms.length === 0) {
    return { played: 0, wins: 0, draws: 0, losses: 0, ppg: null, streak: 0, gfAvg: null, gaAvg: null };
  }
  let wins = 0, draws = 0, losses = 0, pts = 0;
  for (const e of ms) {
    if (e.result === 'W') { wins++; pts += 3; }
    else if (e.result === 'D') { draws++; pts += 1; }
    else losses++;
  }
  // Racha: signo + longitud desde el más reciente (+3 = 3 victorias seguidas).
  let streak = 0;
  const first = ms[0]?.result;
  if (first) {
    for (const e of ms) {
      if (e.result !== first) break;
      streak++;
    }
    if (first === 'L') streak = -streak;
    else if (first === 'D') streak = 0;
  }
  return {
    played: ms.length,
    wins, draws, losses,
    ppg: r2(pts / ms.length),
    streak,
    gfAvg: r2(avg(ms.map((e) => e.goalsFor))),
    gaAvg: r2(avg(ms.map((e) => e.goalsAgainst))),
  };
}

// ADN del equipo por mercado, desde sus últimos 5 (for/against según localía).
function teamRatesFromLast5(last5) {
  const ms = (last5 || []).map((m) => ({ e: m._enriched, g: m.goals })).filter((x) => x.e);
  if (ms.length === 0) return null;
  const cFor = [], cAgainst = [], cardsFor = [], totals = [], gf = [], ga = [];
  const bttsArr = [], over25Arr = [], scoredArr = [], csArr = [];
  for (const { e } of ms) {
    if (e.corners) { cFor.push(e.isHome ? e.corners.home : e.corners.away); cAgainst.push(e.isHome ? e.corners.away : e.corners.home); }
    if (e.yellowCards || e.redCards) {
      const y = e.isHome ? e.yellowCards?.home : e.yellowCards?.away;
      const rc = e.isHome ? e.redCards?.home : e.redCards?.away;
      cardsFor.push((y || 0) + (rc || 0));
    }
    const tot = (e.goalsFor != null && e.goalsAgainst != null) ? e.goalsFor + e.goalsAgainst : null;
    if (tot != null) { totals.push(tot); over25Arr.push(tot); bttsArr.push(e.goalsFor > 0 && e.goalsAgainst > 0); }
    if (e.goalsFor != null) { gf.push(e.goalsFor); scoredArr.push(e.goalsFor > 0); }
    if (e.goalsAgainst != null) { ga.push(e.goalsAgainst); csArr.push(e.goalsAgainst === 0); }
  }
  return {
    cornersForAvg: r2(avg(cFor)),
    cornersAgainstAvg: r2(avg(cAgainst)),
    cardsForAvg: r2(avg(cardsFor)),
    totalGoalsAvg: r2(avg(totals)),
    bttsRate: r2(rate(bttsArr, (x) => x === true)),
    over25Rate: r2(rate(over25Arr, (t) => t > 2.5)),
    scoredRate: r2(rate(scoredArr, (x) => x === true)),
    cleanSheetRate: r2(rate(csArr, (x) => x === true)),
  };
}

// Causalidad: cómo jugó (no solo el marcador). Lee los campos de remates/
// posesión/xG que enrichLastFiveMatches expone en _enriched (null si la liga
// no los provee — frecuente en xG para partidos antiguos).
function causalityFromLast5(last5) {
  const ms = (last5 || []).map((m) => m._enriched).filter(Boolean);
  if (ms.length === 0) return null;
  const pick = (e, field) => (e.isHome ? e[field]?.home : e[field]?.away);
  const pickOpp = (e, field) => (e.isHome ? e[field]?.away : e[field]?.home);
  const shots = ms.map((e) => pick(e, 'shots'));
  const sot = ms.map((e) => pick(e, 'sot'));
  const poss = ms.map((e) => pick(e, 'possession'));
  const xgFor = ms.map((e) => pick(e, 'xg'));
  const xgAg = ms.map((e) => pickOpp(e, 'xg'));
  const xgForAvg = avg(xgFor);
  const xgAgAvg = avg(xgAg);
  return {
    shotsForAvg: r2(avg(shots)),
    sotForAvg: r2(avg(sot)),
    possessionAvg: r2(avg(poss)),
    xgForAvg: r2(xgForAvg),
    xgAgainstAvg: r2(xgAgAvg),
    xgDiffAvg: r2(xgForAvg != null && xgAgAvg != null ? xgForAvg - xgAgAvg : null),
    xgAvailable: xgForAvg != null,
  };
}

// Días de descanso = kickoff − fecha del partido previo más reciente.
function daysRestFromLast5(last5, kickoff) {
  const ko = kickoff ? new Date(kickoff).getTime() : null;
  if (!ko) return null;
  const dates = (last5 || []).map((m) => m.fixture?.date).filter(Boolean).map((d) => new Date(d).getTime()).filter((t) => t < ko).sort((a, b) => b - a);
  if (dates.length === 0) return null;
  return Math.round((ko - dates[0]) / 86400000);
}

// Bajas clave: cuántos del top-3 goleadores/tiradores del equipo están out.
function keyOut(filteredInjuries, playerHighlights, teamId) {
  const outIds = new Set((filteredInjuries || []).filter((i) => i.team?.id === teamId).map((i) => i.player?.id).filter(Boolean));
  const top = new Set([
    ...((playerHighlights?.scorers || []).filter((s) => s.team === teamId).slice(0, 3).map((s) => s.id)),
    ...((playerHighlights?.shooters || []).filter((s) => s.team === teamId).slice(0, 3).map((s) => s.id)),
  ].filter(Boolean));
  let n = 0;
  for (const id of top) if (outIds.has(id)) n++;
  return { keyAttackersOut: n, injuryCount: outIds.size };
}

// Resumen H2H (count + balance + medias).
function h2hSummary(h2h, homeId) {
  const ms = (h2h || []).filter((m) => m.goals?.home != null);
  if (ms.length === 0) return { count: 0 };
  let hw = 0, d = 0, aw = 0; const goals = [];
  for (const m of ms) {
    const homeIsHome = m.teams?.home?.id === homeId;
    const gf = homeIsHome ? m.goals.home : m.goals.away;
    const ga = homeIsHome ? m.goals.away : m.goals.home;
    if (gf > ga) hw++; else if (gf < ga) aw++; else d++;
    if (m.goals.home != null && m.goals.away != null) goals.push(m.goals.home + m.goals.away);
  }
  return { count: ms.length, homeWins: hw, draws: d, awayWins: aw, avgGoals: r2(avg(goals)) };
}

/**
 * Construye el snapshot de features de contexto.
 * @param {object} analysis  objeto de analyzeMatch (o reconstruido point-in-time)
 * @param {object} probs     calculatedProbabilities (para λ base)
 * @returns {object} features_full
 */
function buildFeatureSnapshot(analysis, probs = {}) {
  const a = analysis || {};
  const round = parseRound(a.leagueRound);
  const mw = a.odds?.matchWinner || null;
  const implied = impliedFrom1x2(mw);
  const sc = a.standingsContext || null; // opcional (lo puebla el backfill con tabla reconstruida)

  const motivation = (side) => {
    const s = sc?.[side];
    if (!s) return null;
    return {
      points: s.points ?? null,
      played: s.played ?? null,
      rank: s.rank ?? null,
      matchesRemaining: s.matchesRemaining ?? null,
      gapToLeader: s.gapToLeader ?? null,
      gapToRelegation: s.gapToRelegation ?? null,
      // flags derivadas (heurística simple; el modelo aprende el peso real)
      titleRace: s.gapToLeader != null && s.matchesRemaining != null && s.gapToLeader <= 3 * s.matchesRemaining && (s.rank ?? 99) <= 4,
      relegationFight: s.gapToRelegation != null && s.gapToRelegation <= 6,
    };
  };

  return {
    schema_version: SCHEMA_VERSION,
    built_at: new Date().toISOString(),

    competition: {
      leagueId: a.leagueId ?? null,
      leagueName: a.league ?? null,
      country: a.leagueCountry ?? null,
      round: round.raw,
      roundType: round.type,
      roundNumber: roundNumber(a.leagueRound),
      isKnockout: round.isKnockout,
      isTwoLeg: round.isTwoLeg,
      isFinal: round.isFinal,
    },

    table: {
      homePosition: a.homePosition ?? null,
      awayPosition: a.awayPosition ?? null,
      positionGap: (a.homePosition != null && a.awayPosition != null) ? a.awayPosition - a.homePosition : null,
    },

    market: implied,

    form: {
      home: formFromLast5(a.homeLastFive),
      away: formFromLast5(a.awayLastFive),
    },

    teamRates: {
      home: teamRatesFromLast5(a.homeLastFive),
      away: teamRatesFromLast5(a.awayLastFive),
    },

    causality: {
      home: causalityFromLast5(a.homeLastFive),
      away: causalityFromLast5(a.awayLastFive),
    },

    state: {
      home: { ...keyOut(a.filteredInjuries, a.playerHighlights, a.homeId), daysRest: daysRestFromLast5(a.homeLastFive, a.kickoff) },
      away: { ...keyOut(a.filteredInjuries, a.playerHighlights, a.awayId), daysRest: daysRestFromLast5(a.awayLastFive, a.kickoff) },
    },

    motivation: { home: motivation('home'), away: motivation('away') },

    referee: a.refereeStats ? {
      name: a.refereeStats.name ?? null,
      matches: a.refereeStats.matches ?? null,
      avgCards: a.refereeStats.avgCards ?? null,
    } : null,

    h2h: h2hSummary(a.h2h, a.homeId),

    base: {
      lambdaHome: r2(probs.lambdaHome ?? a.calculatedProbabilities?.lambdaHome),
      lambdaAway: r2(probs.lambdaAway ?? a.calculatedProbabilities?.lambdaAway),
    },
  };
}

// CommonJS para que tanto Next (vía interop de import) como los scripts de
// node "pelados" (require) usen EXACTAMENTE el mismo builder → paridad
// train/score sin duplicar lógica.
module.exports = { buildFeatureSnapshot, FEATURE_SCHEMA_VERSION: SCHEMA_VERSION };
