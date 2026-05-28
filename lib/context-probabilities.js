// ────────────────────────────────────────────────────────────────────────
// Fase 6a — puente entre el MOTOR DE CONTEXTO y el objeto `calculatedProbabilities`
// que consume TODO el frontend (estadísticas descriptivas + mercados), con la
// MISMA shape que producía Dixon-Coles → el frontend no cambia, solo los valores.
//
// DISTINCIÓN CLAVE (decisión del usuario):
//   • Mercados (recomendaciones) → contexto ESPECÍFICO (H2H/segmento) vía el motor
//     (prob_final). Precisión.
//   • Estadísticas descriptivas mostradas → promedio GENERAL del equipo en TODA su
//     temporada (todos sus partidos, ambos venues). Retrato representativo.
//
// Sin Dixon-Coles: NO lambdas, NO isotónica. Los promedios son conteo real.
// ESM (lo importa api-football.js vía import dinámico).
// ────────────────────────────────────────────────────────────────────────

import { buildCombinada } from './combinada.js';

// ── Promedios GENERALES del equipo sobre TODOS sus partidos (ambos venues) ──
function teamAverages(records) {
  const acc = { gf: [], ga: [], cf: [], ca: [], yc: [], rc: [], sf: [], sa: [], sot: [], fl: [], off: [] };
  const push = (arr, v) => { if (v != null && isFinite(v)) arr.push(v); };
  for (const r of records || []) {
    const a = r.actuals; if (!a) continue;
    const side = r.venue, opp = side === 'home' ? 'away' : 'home';
    push(acc.gf, a.goals?.[side]);   push(acc.ga, a.goals?.[opp]);
    push(acc.cf, a.corners?.[side]); push(acc.ca, a.corners?.[opp]);
    push(acc.yc, a.cards?.[side === 'home' ? 'yellowHome' : 'yellowAway']);
    push(acc.rc, a.reds?.[side]);
    push(acc.sf, a.shots?.[side]);   push(acc.sa, a.shots?.[opp]);
    push(acc.sot, a.shots?.[side === 'home' ? 'onTargetHome' : 'onTargetAway']);
    push(acc.fl, a.fouls?.[side]);
    push(acc.off, a.offsides?.[side]);
  }
  const avg = (arr) => arr.length ? +(arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(2) : null;
  return {
    n: (records || []).length,
    goalsFor: avg(acc.gf), goalsAgainst: avg(acc.ga),
    cornersFor: avg(acc.cf), cornersAgainst: avg(acc.ca),
    yellows: avg(acc.yc), reds: avg(acc.rc),
    shotsFor: avg(acc.sf), shotsAgainst: avg(acc.sa), sot: avg(acc.sot),
    fouls: avg(acc.fl), offsides: avg(acc.off),
  };
}

const clampPct = (v) => v == null ? null : Math.max(1, Math.min(99, Math.round(v)));

/**
 * Construye `calculatedProbabilities` desde la salida del motor (scored) + los
 * registros del equipo (inputs.homeRecords/awayRecords) + el análisis.
 * scored: { market_key: { prob, prob_final, level, n, hits, confidence, recommended } }
 */
export function buildProbabilitiesFromContext(scored, inputs, analysis) {
  const homeAvg = teamAverages(inputs.homeRecords);
  const awayAvg = teamAverages(inputs.awayRecords);

  // prob_final (0-1) → % display (1-99). null si el mercado no existe (sin datos).
  const pf = (key) => { const r = scored[key]; return r ? clampPct(r.prob_final * 100) : null; };
  // Construye {_lines, overK_5, underK_5} de una familia OU desde el motor.
  const buildOu = (group) => {
    const out = {}; const lines = new Set();
    const re = new RegExp(`^${group}_(over|under)(\\d+)_5$`);
    for (const k of Object.keys(scored)) {
      const m = k.match(re); if (!m) continue;
      out[`${m[1]}${m[2]}_5`] = clampPct(scored[k].prob_final * 100);
      lines.add(parseFloat(`${m[2]}.5`));
    }
    if (!Object.keys(out).length) return null;
    out._lines = [...lines].sort((a, b) => a - b);
    return out;
  };
  const triple = (h, d, a) => ({ home: pf(h), draw: pf(d), away: pf(a) });

  // ── Estadísticas descriptivas (promedio GENERAL del equipo) ──
  const homeGoals = { avgScored: homeAvg.goalsFor, avgConceded: homeAvg.goalsAgainst, sampleSize: homeAvg.n };
  const awayGoals = { avgScored: awayAvg.goalsFor, avgConceded: awayAvg.goalsAgainst, sampleSize: awayAvg.n };
  const cornerCardData = {
    hasRealData: true, source: 'context-engine',
    homeCornersAvg: homeAvg.cornersFor, homeCornersAgainstAvg: homeAvg.cornersAgainst,
    awayCornersAvg: awayAvg.cornersFor, awayCornersAgainstAvg: awayAvg.cornersAgainst,
    homeYellowsAvg: homeAvg.yellows, homeRedsAvg: homeAvg.reds,
    awayYellowsAvg: awayAvg.yellows, awayRedsAvg: awayAvg.reds,
    totalCornersAvg: (homeAvg.cornersFor != null && awayAvg.cornersFor != null) ? +(homeAvg.cornersFor + awayAvg.cornersFor).toFixed(2) : null,
    totalCardsAvg: (homeAvg.yellows != null && awayAvg.yellows != null) ? +((homeAvg.yellows || 0) + (homeAvg.reds || 0) + (awayAvg.yellows || 0) + (awayAvg.reds || 0)).toFixed(2) : null,
    homeShotsAvg: homeAvg.shotsFor, awayShotsAvg: awayAvg.shotsFor,
    homeFoulsAvg: homeAvg.fouls, awayFoulsAvg: awayAvg.fouls,
    homeOffsidesAvg: homeAvg.offsides, awayOffsidesAvg: awayAvg.offsides,
  };
  const cornerAvg = cornerCardData.totalCornersAvg;
  const cardAvg = cornerCardData.totalCardsAvg;
  const expectedTotal = (homeAvg.goalsFor != null && awayAvg.goalsFor != null) ? +(homeAvg.goalsFor + awayAvg.goalsFor).toFixed(2) : null;

  // ── Mercados (del motor, prob_final) ──
  const perTeamGoals = (side) => ({ over05: pf(`${side}_goals_over0_5`), over15: pf(`${side}_goals_over1_5`), over25: pf(`${side}_goals_over2_5`) });
  const perTeamCorners = (side) => ({ over35: pf(`${side}_corners_over3_5`), over45: pf(`${side}_corners_over4_5`), over55: pf(`${side}_corners_over5_5`) });
  const perTeamCards = (side) => ({ over05: pf(`${side}_cards_over0_5`), over15: pf(`${side}_cards_over1_5`), over25: pf(`${side}_cards_over2_5`) });

  return {
    // Sin lambdas (Dixon-Coles eliminado).
    model: 'context-engine',
    btts: pf('btts'), bttsNo: pf('btts_no'),
    winner: triple('home_win', 'draw', 'away_win'),
    overUnder: { over15: pf('total_goals_over1_5'), over25: pf('total_goals_over2_5'), over35: pf('total_goals_over3_5'),
                 under15: pf('total_goals_under1_5'), under25: pf('total_goals_under2_5'), under35: pf('total_goals_under3_5'),
                 expectedTotal },
    homeGoals, awayGoals,
    cards: { over25: pf('total_cards_over2_5'), over35: pf('total_cards_over3_5'), over45: pf('total_cards_over4_5') },
    corners: { over85: pf('total_corners_over8_5'), over95: pf('total_corners_over9_5'), over105: pf('total_corners_over10_5') },
    cornerAvg, cardAvg, cornerCardData,
    perTeam: {
      home: { goals: perTeamGoals('home'), corners: perTeamCorners('home'), cards: perTeamCards('home') },
      away: { goals: perTeamGoals('away'), corners: perTeamCorners('away'), cards: perTeamCards('away') },
    },
    firstGoal: { before30: pf('first_goal_30'), before45: pf('first_goal_45') },
    shots: buildOu('total_shots'), sot: buildOu('total_sot'), fouls: buildOu('total_fouls'),
    perTeamShots: { home: buildOu('home_shots'), away: buildOu('away_shots') },
    perTeamFouls: { home: buildOu('home_fouls'), away: buildOu('away_fouls') },
    halfGoals: {
      firstHalf: { over05: pf('total_goals_1h_over0_5'), over15: pf('total_goals_1h_over1_5'), over25: pf('total_goals_1h_over2_5') },
      secondHalf: { over05: pf('total_goals_2h_over0_5'), over15: pf('total_goals_2h_over1_5'), over25: pf('total_goals_2h_over2_5') },
    },
    halfWinner: { firstHalf: triple('winner_1h_home', 'winner_1h_draw', 'winner_1h_away'),
                  secondHalf: triple('winner_2h_home', 'winner_2h_draw', 'winner_2h_away') },
    perTeamHalfGoals: {
      home: { firstHalf: { over05: pf('home_goals_1h_over0_5') }, secondHalf: { over05: pf('home_goals_2h_over0_5') } },
      away: { firstHalf: { over05: pf('away_goals_1h_over0_5') }, secondHalf: { over05: pf('away_goals_2h_over0_5') } },
    },
    mostCorners: { fullMatch: triple('most_corners_home', 'most_corners_draw', 'most_corners_away'),
                   firstHalf: triple('most_corners_1h_home', 'most_corners_1h_draw', 'most_corners_1h_away'),
                   secondHalf: triple('most_corners_2h_home', 'most_corners_2h_draw', 'most_corners_2h_away') },
    mostShots: { fullMatch: triple('most_shots_home', 'most_shots_draw', 'most_shots_away') },
    mostFouls: { fullMatch: triple('most_fouls_home', 'most_fouls_draw', 'most_fouls_away') },
    redCards: { anyRed: pf('red_card_any') },
    perTeamRedCards: { home: { anyRed: pf('red_card_home') }, away: { anyRed: pf('red_card_away') } },
    offsides: buildOu('total_offsides'),
    perTeamOffsides: { home: buildOu('home_offsides'), away: buildOu('away_offsides') },
    _contextMeta: { homeMatches: homeAvg.n, awayMatches: awayAvg.n, meetings: inputs._counts?.meetings ?? 0 },
  };
}

// ── Contexto de HOY para el veto (Fase 4) ──
export function buildTodayCtx(analysis) {
  const round = (analysis?.leagueRound || '').toLowerCase();
  const knockout = /final|semi|quarter|round of|1\/8|knockout|play-?off|elimination/.test(round);
  const inj = analysis?.filteredInjuries || analysis?.injuries?.data || [];
  const keyInjury = Array.isArray(inj) ? inj.length > 0 : false;
  return { knockout, keyInjury, rotationRisk: 0, earlyRedRisk: 0, homeTeamAway: false };
}

// ── Recomendaciones (gate unificado) desde el motor + player props reales ──
// Solo mercados con recommended===true (prob_final≥90 + piso H2H/ADN + rupture<τ)
// Y cuota real del bookmaker ≥ MIN_ODD. Los player props vienen del builder
// existente (frecuencia real, no DC).
const MIN_ODD = 1.20;

function oddFor(key, odds) {
  if (!odds) return null;
  const direct = {
    home_win: odds.matchWinner?.home, draw: odds.matchWinner?.draw, away_win: odds.matchWinner?.away,
    btts: odds.btts?.yes, btts_no: odds.btts?.no,
    winner_1h_home: odds.winner1H?.home, winner_1h_draw: odds.winner1H?.draw, winner_1h_away: odds.winner1H?.away,
    winner_2h_home: odds.winner2H?.home, winner_2h_draw: odds.winner2H?.draw, winner_2h_away: odds.winner2H?.away,
    most_corners_home: odds.corners1x2?.home, most_corners_draw: odds.corners1x2?.draw, most_corners_away: odds.corners1x2?.away,
    most_corners_1h_home: odds.corners1x21H?.home, most_corners_1h_away: odds.corners1x21H?.away,
    most_corners_2h_home: odds.corners1x22H?.home, most_corners_2h_away: odds.corners1x22H?.away,
    most_shots_home: odds.shots1x2?.home, most_shots_draw: odds.shots1x2?.draw, most_shots_away: odds.shots1x2?.away,
    most_fouls_home: odds.fouls1x2?.home, most_fouls_draw: odds.fouls1x2?.draw, most_fouls_away: odds.fouls1x2?.away,
    red_card_any: odds.redCard?.yes, red_card_home: odds.homeRedCard?.yes, red_card_away: odds.awayRedCard?.yes,
    first_goal_30: odds.firstGoal?.before30, first_goal_45: odds.firstGoal?.before45,
  };
  if (key in direct) return direct[key];
  const ou = key.match(/^(.+)_(over|under)(\d+)_5$/);
  if (ou) {
    const oddKey = `${ou[2] === 'over' ? 'Over' : 'Under'}_${ou[3]}_5`;
    const g = {
      total_goals: odds.overUnder, total_corners: odds.corners, total_cards: odds.cards,
      total_shots: odds.shots, total_sot: odds.sot, total_fouls: odds.fouls, total_offsides: odds.offsides,
      home_goals: odds.homeGoals, away_goals: odds.awayGoals, home_corners: odds.homeCorners, away_corners: odds.awayCorners,
      home_cards: odds.homeCards, away_cards: odds.awayCards, home_shots: odds.homeShots, away_shots: odds.awayShots,
      home_fouls: odds.homeFouls, away_fouls: odds.awayFouls, home_offsides: odds.homeOffsides, away_offsides: odds.awayOffsides,
      total_goals_1h: odds.goals1H, total_goals_2h: odds.goals2H,
      home_goals_1h: odds.homeGoals1H, away_goals_1h: odds.awayGoals1H, home_goals_2h: odds.homeGoals2H, away_goals_2h: odds.awayGoals2H,
    }[ou[1]];
    return g?.[oddKey] ?? null;
  }
  const ah = key.match(/^ah_(home|away)_([mp]\d+_\d+)$/);
  if (ah) return odds.asianHandicap?.[`${ah[1]}_${ah[2]}`] ?? null;
  return null;
}

function marketLabel(key, teamNames) {
  const H = teamNames?.home || 'Local', A = teamNames?.away || 'Visitante';
  const ou = key.match(/^(.+)_(over|under)(\d+)_5$/);
  if (ou) {
    const ln = `${ou[3]}.5`, dir = ou[2] === 'over' ? 'Más de' : 'Menos de';
    const fam = { total_goals: 'Total — Goles', total_corners: 'Total — Córners', total_cards: 'Total — Tarjetas',
      total_shots: 'Total — Tiros', total_sot: 'Total — Tiros a puerta', total_fouls: 'Total — Faltas', total_offsides: 'Total — Offsides',
      home_goals: `${H} — Goles`, away_goals: `${A} — Goles`, home_corners: `${H} — Córners`, away_corners: `${A} — Córners`,
      home_cards: `${H} — Tarjetas`, away_cards: `${A} — Tarjetas`, total_goals_1h: '1ª Parte — Goles', total_goals_2h: '2ª Parte — Goles' }[ou[1]] || ou[1];
    return `${fam} ${dir} ${ln}`;
  }
  const lbl = {
    home_win: `Ganador — ${H}`, draw: 'Empate', away_win: `Ganador — ${A}`,
    btts: 'Ambos marcan SÍ', btts_no: 'Ambos marcan NO',
    red_card_any: 'Habrá tarjeta roja', red_card_home: `${H} — Tarjeta roja`, red_card_away: `${A} — Tarjeta roja`,
    first_goal_30: 'Primer gol antes del 30\'', first_goal_45: 'Primer gol antes del 45\'',
    most_corners_home: `Más córners — ${H}`, most_corners_away: `Más córners — ${A}`,
  };
  return lbl[key] || key;
}

function categoryOf(key) {
  const ou = key.match(/^(.+)_(over|under)\d+_5$/);
  if (ou) return `${ou[1]}-${ou[2]}`;
  if (/^ah_/.test(key)) return 'asian-handicap';
  return key;
}

export function buildContextCombinada(scored, odds, teamNames, playerHighlights, probabilities) {
  const markets = [];
  for (const [key, r] of Object.entries(scored)) {
    if (!r.recommended) continue;
    const odd = parseFloat(oddFor(key, odds));
    if (!isFinite(odd) || odd < MIN_ODD) continue;
    markets.push({
      id: key, category: categoryOf(key), scope: 'context',
      name: marketLabel(key, teamNames), probability: clampPct(r.prob_final * 100),
      odd, level: r.level, confidence: Math.round((r.confidence || 0) * 100), sampleN: r.n,
    });
  }
  // Dedup por categoría → mejor probabilidad.
  const best = {};
  for (const m of markets) { const e = best[m.category]; if (!e || m.probability > e.probability) best[m.category] = m; }
  const teamSel = Object.values(best);

  // Player props reales (del builder existente; frecuencia, no DC).
  let playerSel = [];
  try {
    const pc = buildCombinada(probabilities, odds, playerHighlights, teamNames);
    playerSel = (pc.selections || []).filter(s => s.scope === 'player');
  } catch {}

  const selected = [...teamSel, ...playerSel].filter(m => m.odd > MIN_ODD - 1e-9).sort((a, b) => b.probability - a.probability);
  if (!selected.length) {
    return { selections: [], combinedOdd: null, combinedProbability: 0, highRisk: false, hasRealOdds: false, threshold: 90, source: 'context-engine' };
  }
  const combinedOdd = selected.reduce((acc, m) => acc * m.odd, 1);
  const combinedProbability = selected.reduce((acc, m) => acc + m.probability, 0) / selected.length;
  return {
    selections: selected,
    combinedOdd: +combinedOdd.toFixed(2),
    combinedProbability: +combinedProbability.toFixed(1),
    highRisk: combinedProbability < 60,
    hasRealOdds: true,
    threshold: Math.min(...selected.map(m => m.probability)),
    source: 'context-engine',
  };
}
