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
// Helpers DESCRIPTIVOS (forma L5, H2H, goal timing) — NO son el modelo Dixon-Coles
// (no usan lambdas), solo resumen de datos. Reusados para que los widgets del
// frontend reciban la MISMA shape que esperaban.
import { calculateForm, calculateH2HGoalAvg, calculateH2HSummary, calculateGoalTimingProbabilities } from './descriptive-stats.js';
import { marketLabel } from './market-labels.js';

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

  // ── Widgets descriptivos del frontend (forma L5, H2H, goal timing) ──
  // Del dato en vivo (homeLastFive/h2h/goalTimingData), shape EXACTA que esperan
  // los componentes (algunos los leen sin optional-chaining: p.h2hGoals.homeAvg).
  const aIn = analysis || {};
  const homeForm   = calculateForm(aIn.homeLastFive, aIn.homeId);
  const awayForm   = calculateForm(aIn.awayLastFive, aIn.awayId);
  const h2hGoals   = calculateH2HGoalAvg(aIn.h2h, aIn.homeId);
  const h2hSummary = calculateH2HSummary(aIn.h2h, aIn.homeId, aIn.awayId);
  const goalTiming = aIn.goalTimingData ? calculateGoalTimingProbabilities(aIn.goalTimingData) : null;

  // ── Mercados (del motor, prob_final) ──
  // Cada familia expone TODAS las líneas que el motor calculó (buildOu → over{N}_5 +
  // _lines) y MANTIENE las claves legacy (over05/over15/…) para consumidores viejos.
  const perTeamGoals = (side) => ({ ...buildOu(`${side}_goals`), over05: pf(`${side}_goals_over0_5`), over15: pf(`${side}_goals_over1_5`), over25: pf(`${side}_goals_over2_5`) });
  const perTeamCorners = (side) => ({ ...buildOu(`${side}_corners`), over35: pf(`${side}_corners_over3_5`), over45: pf(`${side}_corners_over4_5`), over55: pf(`${side}_corners_over5_5`) });
  const perTeamCards = (side) => ({ ...buildOu(`${side}_cards`), over05: pf(`${side}_cards_over0_5`), over15: pf(`${side}_cards_over1_5`), over25: pf(`${side}_cards_over2_5`) });
  // (Hándicap asiático eliminado — no se emite asianHandicap.)

  return {
    // Sin lambdas (Dixon-Coles eliminado).
    model: 'context-engine',
    btts: pf('btts'), bttsNo: pf('btts_no'),
    winner: triple('home_win', 'draw', 'away_win'),
    // TODAS las líneas (buildOu) + legacy keys (over15/over25/over35 + unders + expectedTotal).
    overUnder: { ...buildOu('total_goals'),
                 over15: pf('total_goals_over1_5'), over25: pf('total_goals_over2_5'), over35: pf('total_goals_over3_5'),
                 under15: pf('total_goals_under1_5'), under25: pf('total_goals_under2_5'), under35: pf('total_goals_under3_5'),
                 expectedTotal },
    homeGoals, awayGoals,
    homeForm, awayForm, h2hGoals, h2hSummary, goalTiming,
    cards: { ...buildOu('total_cards'), over25: pf('total_cards_over2_5'), over35: pf('total_cards_over3_5'), over45: pf('total_cards_over4_5') },
    corners: { ...buildOu('total_corners'), over85: pf('total_corners_over8_5'), over95: pf('total_corners_over9_5'), over105: pf('total_corners_over10_5') },
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
      firstHalf: { ...buildOu('total_goals_1h'), over05: pf('total_goals_1h_over0_5'), over15: pf('total_goals_1h_over1_5'), over25: pf('total_goals_1h_over2_5') },
      secondHalf: { ...buildOu('total_goals_2h'), over05: pf('total_goals_2h_over0_5'), over15: pf('total_goals_2h_over1_5'), over25: pf('total_goals_2h_over2_5') },
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

// market_key → [campo en allBookmakerOdds, claveDeLínea]. null si no mapeable.
function resolveOddField(key) {
  const direct = {
    home_win: ['matchWinner', 'home'], draw: ['matchWinner', 'draw'], away_win: ['matchWinner', 'away'],
    btts: ['btts', 'yes'], btts_no: ['btts', 'no'],
    winner_1h_home: ['winner1H', 'home'], winner_1h_draw: ['winner1H', 'draw'], winner_1h_away: ['winner1H', 'away'],
    winner_2h_home: ['winner2H', 'home'], winner_2h_draw: ['winner2H', 'draw'], winner_2h_away: ['winner2H', 'away'],
    most_corners_home: ['corners1x2', 'home'], most_corners_draw: ['corners1x2', 'draw'], most_corners_away: ['corners1x2', 'away'],
    most_corners_1h_home: ['corners1x21H', 'home'], most_corners_1h_away: ['corners1x21H', 'away'],
    most_corners_2h_home: ['corners1x22H', 'home'], most_corners_2h_away: ['corners1x22H', 'away'],
    most_shots_home: ['shots1x2', 'home'], most_shots_draw: ['shots1x2', 'draw'], most_shots_away: ['shots1x2', 'away'],
    most_fouls_home: ['fouls1x2', 'home'], most_fouls_draw: ['fouls1x2', 'draw'], most_fouls_away: ['fouls1x2', 'away'],
  };
  if (key in direct) return direct[key];
  const ou = key.match(/^(.+)_(over|under)(\d+)_5$/);
  if (ou) {
    const lineKey = `${ou[2] === 'over' ? 'Over' : 'Under'}_${ou[3]}_5`;
    const field = {
      total_goals: 'overUnder', total_corners: 'corners', total_cards: 'cards',
      total_shots: 'shots', total_sot: 'sot', total_fouls: 'fouls',
      home_goals: 'homeGoals', away_goals: 'awayGoals', home_corners: 'homeCorners', away_corners: 'awayCorners',
      home_cards: 'homeCards', away_cards: 'awayCards', home_shots: 'homeShots', away_shots: 'awayShots',
      home_fouls: 'homeFouls', away_fouls: 'awayFouls',
      total_goals_1h: 'goals1H', total_goals_2h: 'goals2H',
      home_goals_1h: 'homeGoals1H', away_goals_1h: 'awayGoals1H', home_goals_2h: 'homeGoals2H', away_goals_2h: 'awayGoals2H',
    }[ou[1]];
    return field ? [field, lineKey] : null;
  }
  // (Hándicap eliminado — no se resuelve ni se recomienda.)
  return null;
}

// Claves de cuota EQUIVALENTES para una línea .5 del motor. Los eventos son enteros
// (no hay medio gol/córner/tarjeta), así que la línea entera del bookmaker gana en
// EXACTAMENTE el mismo escenario que la media línea del motor:
//   over_X_5  (gana si caen X+1 o más) ↔ "Over X.5" ↔ "Over X" (entera)
//   under_X_5 (gana si caen X o menos)  ↔ "Under X.5" ↔ "Under X+1" (entera)
// Se prefiere la media exacta; si no existe, la entera equivalente. NUNCA cuartos
// asiáticos (Over_1_25 / Over_1_75): son apuestas split distintas → no equivalen.
function equivalentLineKeys(lineKey) {
  let m = lineKey.match(/^Over_(\d+)_5$/);
  if (m) return [`Over_${m[1]}_5`, `Over_${m[1]}`];
  m = lineKey.match(/^Under_(\d+)_5$/);
  if (m) return [`Under_${m[1]}_5`, `Under_${Number(m[1]) + 1}`];
  return [lineKey];
}

// REGLA INVIOLABLE: una recomendación solo existe si ALGÚN bookmaker autorizado la
// cotiza con cuota real ≥ MIN_ODD. Busca SOLO en allBookmakerOdds (cuotas reales con
// atribución), NUNCA en los agregados. Acepta la línea entera equivalente cuando el
// bookmaker no ofrece la media (Over X = Over X.5, Under X+1 = Under X.5). Devuelve la
// MEJOR cuota entre los bookmakers que sí la ofrecen. null = no recomendable.
function oddFor(key, odds) {
  const allBks = odds?.allBookmakerOdds;
  if (!Array.isArray(allBks) || !allBks.length) return null;
  const resolved = resolveOddField(key);
  if (!resolved) return null;
  const [field, lineKey] = resolved;
  const candidates = equivalentLineKeys(lineKey);
  let best = null;
  for (const bk of allBks) {
    const fam = bk?.[field];
    if (!fam) continue;
    // Dentro de un bookmaker: preferir la media exacta; si no, la entera equivalente.
    for (const ck of candidates) {
      const odd = fam[ck];
      if (typeof odd !== 'number' || !isFinite(odd) || odd < MIN_ODD) continue;
      if (!best || odd > best.odd) best = { odd, bookmaker: bk.name };
      break;
    }
  }
  return best;
}

// Normalizador de nombre de jugador (mismo criterio que api-football.js) para
// atribuir player props a un bookmaker desde allBookmakerOdds.players.
function normPlayer(name) {
  return (name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
// Atribuye una selección de player prop al bookmaker que ofrece su cuota (≥MIN_ODD).
// category: 'scorer-ID'|'assists-ID'|'booked-ID'|'shotsOn-ID'|'shotsTotal-ID'|'fouls-ID'.
function attributePlayer(sel, allBks) {
  if (!Array.isArray(allBks) || !allBks.length) return null;
  const fieldMap = { scorer: 'scorer', assists: 'assists', booked: 'booked', shotsOn: 'shotsOn', shotsTotal: 'shotsTotal', fouls: 'fouls' };
  const type = (sel.category || '').split('-')[0];
  const field = fieldMap[type];
  if (!field) return null;
  const norm = normPlayer(sel.playerName);
  if (!norm) return null;
  const lastName = norm.split(' ').pop();
  const lineStr = sel._line != null ? String(sel._line) : null; // byLine markets
  const pick = (bucket) => {
    if (!bucket) return undefined;
    let entry = bucket[norm];
    if (entry === undefined && lastName && lastName.length >= 3) {
      for (const [k, v] of Object.entries(bucket)) { if (k === lastName || k.endsWith(' ' + lastName)) { entry = v; break; } }
    }
    if (entry === undefined) return undefined;
    return lineStr != null ? (typeof entry === 'object' ? entry[lineStr] : undefined) : entry;
  };
  let best = null;
  for (const bk of allBks) {
    const odd = pick(bk?.players?.[field]);
    if (typeof odd !== 'number' || !isFinite(odd) || odd < MIN_ODD) continue;
    if (!best || odd > best.odd) best = { odd, bookmaker: bk.name };
  }
  return best ? best.bookmaker : null;
}

// marketLabel se importa de ./market-labels.js (puro, compartido con el cliente).

function categoryOf(key) {
  const ou = key.match(/^(.+)_(over|under)\d+_5$/);
  if (ou) return `${ou[1]}-${ou[2]}`;
  return key;
}

export function buildContextCombinada(scored, odds, teamNames, playerHighlights, probabilities) {
  const allBks = odds?.allBookmakerOdds;
  const markets = [];
  for (const [key, r] of Object.entries(scored)) {
    if (!r.recommended) continue;
    if (key.startsWith('ah_')) continue; // hándicap eliminado del catálogo
    // Cuota REAL con bookmaker identificado (de allBookmakerOdds). Sin esto → fuera.
    const o = oddFor(key, odds);
    if (!o) continue;
    markets.push({
      id: key, category: categoryOf(key), scope: 'context',
      name: marketLabel(key, teamNames), probability: clampPct(r.prob_final * 100),
      odd: o.odd, bookmaker: o.bookmaker,
      level: r.level, confidence: Math.round((r.confidence || 0) * 100), sampleN: r.n,
    });
  }
  // SIN dedup por categoría: se exponen TODAS las líneas recomendadas con cuota real
  // (p.ej. corners over_5_5, over_6_5, over_7_5… si el motor las recomienda y bet365/
  // bwin las cotizan). El usuario elige; la combinada del día las muestra todas.
  const teamSel = markets;

  // Player props reales (del builder existente; frecuencia, no DC). Atribuye cada
  // uno a su bookmaker desde allBookmakerOdds.players; si no se puede atribuir a
  // ningún bookmaker autorizado → fuera (misma regla inviolable).
  let playerSel = [];
  try {
    const pc = buildCombinada(probabilities, odds, playerHighlights, teamNames);
    playerSel = (pc.selections || [])
      .filter(s => s.scope === 'player')
      .map(s => ({ ...s, bookmaker: attributePlayer(s, allBks) }))
      .filter(s => s.bookmaker);
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
