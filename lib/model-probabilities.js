/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// lib/model-probabilities.js — Etapa 4 (Diseño B). Reemplaza context-probabilities.js
// y la parte descriptiva de context-engine.js. Puente entre el MOTOR NUEVO
// (predict() → modelToScored → `scored`) y el objeto `calculatedProbabilities` +
// `combinada` que YA consume el frontend (MISMA shape; solo cambia la FUENTE).
//
//   • Mercados: del motor nuevo (schema model), vía scored.
//   • Stats descriptivas: AVG sobre model.team_match_stats (antes raw fixtures).
//   • Player props: buildPlayerMarkets (Etapa 3) → playerMarketsToSelections.
//   • Gate de cuota 1.20 + atribución a bookmaker: oddFor / playerOddFor sobre
//     allBookmakerOdds (incluye hándicap asiático/europeo + marcador exacto, nuevos).
//
// `source` de la combinada se mantiene 'context-engine' a propósito: es el
// discriminador que leen el dashboard y el cron publish-combinada ("combinada ya
// gateada, úsala directo"); es un marcador de comportamiento, no el módulo viejo.
// ESM (api-football.js la importa por import dinámico). Pura salvo las 2 queries AVG.
// ────────────────────────────────────────────────────────────────────────

import { calculateForm, calculateH2HGoalAvg, calculateH2HSummary, calculateGoalTimingProbabilities } from './descriptive-stats.js';
import { marketLabel } from './market-labels.js';
import { playerMarketsToSelections } from './model-to-scored.js';

const MIN_ODD = 1.20;
const clampPct = (v) => v == null ? null : Math.max(1, Math.min(99, Math.round(v)));
const r2 = (x) => (x == null || !isFinite(x) ? null : +Number(x).toFixed(2));

// phaseOf — ESPEJO EXACTO de model-ingest.js (la fase del serving debe coincidir
// con la fase ingerida para que la escalera de contexto del motor case).
const phaseOf = (round) => { const r = String(round || '').toLowerCase(); if (/\bfinal\b/.test(r) && !/semi|quarter|round of|1\/8/.test(r)) return 'final'; if (/semi|quarter|round of|1\/8|knockout|play-?off|elimination/.test(r)) return 'knockout'; if (/group/.test(r)) return 'group'; return 'regular'; };

// ── ctx para predict(): comp/season/ranks/nTeams/phase desde el fixture + standings ──
//   competitionId = fixture.league.id (model.competition_id == API league.id, verificado en ingest)
//   season        = fixture.league.season
//   phase         = phaseOf(fixture.league.round)
//   homeRank/awayRank = posiciones oficiales que ya trae analysis (homePosition/awayPosition)
//   nTeams        = equipos del último snapshot de standings del modelo (best-effort; null → el
//                   motor degrada: tier()=null y usa niveles L2/L3 de localía/todo)
export async function buildModelCtx(pool, { fixtureId, leagueId, season, round, homeId, awayId, homeRank, awayRank, cutoff }) {
  let nTeams = null;
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM model.standings_snapshots
       WHERE competition_id=$1 AND season=$2
         AND as_of_date=(SELECT max(as_of_date) FROM model.standings_snapshots WHERE competition_id=$1 AND season=$2)`,
      [leagueId, season]);
    nTeams = rows[0]?.n || null;
  } catch { /* sin standings → nTeams null (degradación limpia) */ }
  return {
    fixtureId: Number(fixtureId), homeTeamId: Number(homeId), awayTeamId: Number(awayId),
    competitionId: Number(leagueId), season: season != null ? Number(season) : null,
    phase: phaseOf(round),
    homeRank: homeRank != null ? Number(homeRank) : null,
    awayRank: awayRank != null ? Number(awayRank) : null,
    nTeams, cutoff: cutoff || new Date(),
  };
}

// ── Stats descriptivas: promedio GENERAL del equipo (ambos venues) desde el modelo ──
// MISMA estructura que producía teamAverages(inputs.homeRecords) en context-probabilities,
// pero contada de model.team_match_stats (la misma fuente que los mercados → coherencia).
async function teamAvg(pool, teamId, cutoff) {
  const { rows } = await pool.query(
    `SELECT count(*)::int n,
            avg(goals_for) gf, avg(goals_against) ga, avg(corners_for) cf, avg(corners_against) ca,
            avg(yellow_for) yc, avg(red_for) rc, avg(shots_for) sf, avg(shots_against) sa,
            avg(sot_for) sot, avg(fouls_for) fl, avg(offsides_for) off
     FROM model.team_match_stats WHERE team_id=$1 AND kickoff<$2`, [teamId, cutoff]);
  const a = rows[0] || {};
  return {
    n: a.n || 0,
    goalsFor: r2(a.gf), goalsAgainst: r2(a.ga),
    cornersFor: r2(a.cf), cornersAgainst: r2(a.ca),
    yellows: r2(a.yc), reds: r2(a.rc),
    shotsFor: r2(a.sf), shotsAgainst: r2(a.sa), sot: r2(a.sot),
    fouls: r2(a.fl), offsides: r2(a.off),
  };
}

// Devuelve { homeAvg, awayAvg, meetings } — reemplaza loadContextInputs para lo descriptivo.
export async function buildModelDescriptives(pool, ctx) {
  const cutoff = ctx.cutoff || new Date();
  const [homeAvg, awayAvg, mt] = await Promise.all([
    teamAvg(pool, ctx.homeTeamId, cutoff),
    teamAvg(pool, ctx.awayTeamId, cutoff),
    pool.query(`SELECT count(*)::int n FROM model.team_match_stats WHERE team_id=$1 AND opponent_id=$2 AND kickoff<$3`,
      [ctx.homeTeamId, ctx.awayTeamId, cutoff]),
  ]);
  return { homeAvg, awayAvg, meetings: mt.rows[0]?.n || 0 };
}

// Disponibilidad de datos REALES por categoría (de los arrays *PerMatch de cornerCardData).
function availabilityFromStats(sd) {
  const has = (a, b) => (Array.isArray(a) && a.length > 0) || (Array.isArray(b) && b.length > 0);
  return {
    corners:  has(sd?.homeCornersPerMatch,  sd?.awayCornersPerMatch),
    cards:    has(sd?.homeCardsPerMatch,    sd?.awayCardsPerMatch),
    shots:    has(sd?.homeShotsPerMatch,    sd?.awayShotsPerMatch),
    sot:      has(sd?.homeSotPerMatch,      sd?.awaySotPerMatch),
    fouls:    has(sd?.homeFoulsPerMatch,    sd?.awayFoulsPerMatch),
    offsides: has(sd?.homeOffsidesPerMatch, sd?.awayOffsidesPerMatch),
  };
}

// ── calculatedProbabilities: MISMA shape que buildProbabilitiesFromContext ──
// scored: { market_key: { prob, prob_final, level, n, hits, confidence, recommended } }
// descriptives: { homeAvg, awayAvg, meetings } (de buildModelDescriptives)
export function buildCalculatedProbabilities(scored, descriptives, analysis) {
  const homeAvg = descriptives.homeAvg, awayAvg = descriptives.awayAvg;
  const pf = (key) => { const r = scored[key]; return r ? clampPct(r.prob_final * 100) : null; };
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

  const homeGoals = { avgScored: homeAvg.goalsFor, avgConceded: homeAvg.goalsAgainst, sampleSize: homeAvg.n };
  const awayGoals = { avgScored: awayAvg.goalsFor, avgConceded: awayAvg.goalsAgainst, sampleSize: awayAvg.n };
  const dataAvailability = availabilityFromStats(analysis?.cornerCardData);
  const cornerCardData = {
    hasRealData: dataAvailability.corners || dataAvailability.cards,
    dataAvailability, source: 'context-engine',
    homeCornersAvg: homeAvg.cornersFor, homeCornersAgainstAvg: homeAvg.cornersAgainst,
    awayCornersAvg: awayAvg.cornersFor, awayCornersAgainstAvg: awayAvg.cornersAgainst,
    homeYellowsAvg: homeAvg.yellows, homeRedsAvg: homeAvg.reds,
    awayYellowsAvg: awayAvg.yellows, awayRedsAvg: awayAvg.reds,
    totalCornersAvg: (homeAvg.cornersFor != null && awayAvg.cornersFor != null) ? +(homeAvg.cornersFor + awayAvg.cornersFor).toFixed(2) : null,
    totalCardsAvg: (homeAvg.yellows != null && awayAvg.yellows != null) ? +((homeAvg.yellows || 0) + (homeAvg.reds || 0) + (awayAvg.yellows || 0) + (awayAvg.reds || 0)).toFixed(2) : null,
    homeShotsAvg: homeAvg.shotsFor, awayShotsAvg: awayAvg.shotsFor,
    homeSotAvg: homeAvg.sot, awaySotAvg: awayAvg.sot,
    homeFoulsAvg: homeAvg.fouls, awayFoulsAvg: awayAvg.fouls,
    homeOffsidesAvg: homeAvg.offsides, awayOffsidesAvg: awayAvg.offsides,
  };
  const cornerAvg = cornerCardData.totalCornersAvg;
  const cardAvg = cornerCardData.totalCardsAvg;
  const expectedTotal = (homeAvg.goalsFor != null && awayAvg.goalsFor != null) ? +(homeAvg.goalsFor + awayAvg.goalsFor).toFixed(2) : null;

  const aIn = analysis || {};
  const homeForm   = calculateForm(aIn.homeLastFive, aIn.homeId);
  const awayForm   = calculateForm(aIn.awayLastFive, aIn.awayId);
  const h2hGoals   = calculateH2HGoalAvg(aIn.h2h, aIn.homeId);
  const h2hSummary = calculateH2HSummary(aIn.h2h, aIn.homeId, aIn.awayId);
  const goalTiming = aIn.goalTimingData ? calculateGoalTimingProbabilities(aIn.goalTimingData) : null;

  const perTeamGoals = (side) => ({ ...buildOu(`${side}_goals`), over05: pf(`${side}_goals_over0_5`), over15: pf(`${side}_goals_over1_5`), over25: pf(`${side}_goals_over2_5`) });
  const perTeamCorners = (side) => ({ ...buildOu(`${side}_corners`), over35: pf(`${side}_corners_over3_5`), over45: pf(`${side}_corners_over4_5`), over55: pf(`${side}_corners_over5_5`) });
  const perTeamCards = (side) => ({ ...buildOu(`${side}_cards`), over05: pf(`${side}_cards_over0_5`), over15: pf(`${side}_cards_over1_5`), over25: pf(`${side}_cards_over2_5`) });

  return {
    model: 'model-engine',
    btts: pf('btts'), bttsNo: pf('btts_no'),
    winner: triple('home_win', 'draw', 'away_win'),
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
    _contextMeta: { homeMatches: homeAvg.n, awayMatches: awayAvg.n, meetings: descriptives.meetings ?? 0 },
  };
}

// ── resolución de cuota (gate 1.20) — EXTENDIDA con hándicap + marcador exacto ──
function resolveOddField(key) {
  const direct = {
    home_win: ['matchWinner', 'home'], draw: ['matchWinner', 'draw'], away_win: ['matchWinner', 'away'],
    dc_1x: ['doubleChance', '1x'], dc_12: ['doubleChance', '12'], dc_x2: ['doubleChance', 'x2'],
    clean_sheet_home: ['cleanSheetHome', 'yes'], clean_sheet_away: ['cleanSheetAway', 'yes'],
    goals_odd: ['oddEven', 'odd'], goals_even: ['oddEven', 'even'],
    exact_goals_0: ['exactGoals', '0'], exact_goals_1: ['exactGoals', '1'], exact_goals_2: ['exactGoals', '2'],
    exact_goals_3: ['exactGoals', '3'], exact_goals_4: ['exactGoals', '4'], exact_goals_5: ['exactGoals', '5'],
    exact_goals_6: ['exactGoals', '6'], exact_goals_7plus: ['exactGoals', '7plus'],
    btts: ['btts', 'yes'], btts_no: ['btts', 'no'],
    winner_1h_home: ['winner1H', 'home'], winner_1h_draw: ['winner1H', 'draw'], winner_1h_away: ['winner1H', 'away'],
    winner_2h_home: ['winner2H', 'home'], winner_2h_draw: ['winner2H', 'draw'], winner_2h_away: ['winner2H', 'away'],
    most_corners_home: ['corners1x2', 'home'], most_corners_draw: ['corners1x2', 'draw'], most_corners_away: ['corners1x2', 'away'],
    most_shots_home: ['shots1x2', 'home'], most_shots_draw: ['shots1x2', 'draw'], most_shots_away: ['shots1x2', 'away'],
    most_fouls_home: ['fouls1x2', 'home'], most_fouls_draw: ['fouls1x2', 'draw'], most_fouls_away: ['fouls1x2', 'away'],
    // NUEVO — hándicap asiático local (claves que emite el parser: 'Home_-0.5' etc.)
    ah_home_m0_5: ['asianHandicap', 'Home_-0.5'], ah_home_m1_5: ['asianHandicap', 'Home_-1.5'],
    ah_home_p0_5: ['asianHandicap', 'Home_+0.5'], ah_home_p1_5: ['asianHandicap', 'Home_+1.5'],
    // NUEVO — hándicap europeo (3-way) local
    eh_home_m1: ['handicap', 'Home_-1'], eh_home_p1: ['handicap', 'Home_+1'],
  };
  if (key in direct) return direct[key];
  // NUEVO — marcador exacto cs_h_a → correctScore 'h:a'
  const cs = key.match(/^cs_(\d+)_(\d+)$/);
  if (cs) return ['correctScore', `${cs[1]}:${cs[2]}`];
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
  return null;
}

// Líneas .5 → entera equivalente (OU). Hándicap/correctScore no tienen equivalente entero.
function equivalentLineKeys(lineKey) {
  let m = lineKey.match(/^Over_(\d+)_5$/);
  if (m) return [`Over_${m[1]}_5`, `Over_${m[1]}`];
  m = lineKey.match(/^Under_(\d+)_5$/);
  if (m) return [`Under_${m[1]}_5`, `Under_${Number(m[1]) + 1}`];
  return [lineKey];
}

// Cuota ≥MIN_ODD para un market_key del motor. (1) Por-bookmaker (con atribución a
// bet365/bwin) desde allBookmakerOdds. (2) FALLBACK al agregado odds[field] cuando la
// línea no está por-bookmaker (gap del merge de fuentes): no se pierde el pick, pero se
// marca bookmaker genérico 'bet365/bwin' (el agregado es la mejor cuota entre los permitidos,
// sin registrar cuál). Tras el fix de mergeOdds (familia-por-familia) el fallback casi no
// se dispara; queda como red de seguridad para no devolver 0 selecciones por una asimetría.
function oddFor(key, odds) {
  if (!odds) return null;
  const resolved = resolveOddField(key);
  if (!resolved) return null;
  const [field, lineKey] = resolved;
  const candidates = equivalentLineKeys(lineKey);
  // (1) por-bookmaker — mejor cuota CON atribución
  let best = null;
  const allBks = odds.allBookmakerOdds;
  if (Array.isArray(allBks)) {
    for (const bk of allBks) {
      const fam = bk?.[field];
      if (!fam) continue;
      for (const ck of candidates) {
        const odd = fam[ck];
        if (typeof odd !== 'number' || !isFinite(odd) || odd < MIN_ODD) continue;
        if (!best || odd > best.odd) best = { odd, bookmaker: bk.name };
        break;
      }
    }
  }
  if (best) return best;
  // (2) FALLBACK al agregado (sin atribución de bookmaker concreto)
  const agg = odds[field];
  if (agg) {
    for (const ck of candidates) {
      const odd = agg[ck];
      if (typeof odd === 'number' && isFinite(odd) && odd >= MIN_ODD) return { odd, bookmaker: 'bet365/bwin' };
    }
  }
  return null;
}

const normPlayer = (name) => (name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

// Cuota (y bookmaker) de una selección de player prop del modelo, ≥MIN_ODD. Devuelve
// {odd, bookmaker} (a diferencia del attributePlayer viejo, que solo daba el nombre):
// el modelo no trae cuota, así que la tomamos del bookmaker aquí. category: '<tipo>-<id>'.
function playerOddFor(sel, allBks) {
  if (!Array.isArray(allBks) || !allBks.length) return null;
  const fieldMap = { scorer: 'scorer', assists: 'assists', booked: 'booked', shotsOn: 'shotsOn', shotsTotal: 'shotsTotal', fouls: 'fouls' };
  const field = fieldMap[(sel.category || '').split('-')[0]];
  if (!field) return null;
  const norm = normPlayer(sel.playerName); if (!norm) return null;
  const lastName = norm.split(' ').pop();
  const lineStr = sel._line != null ? String(sel._line) : null;
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
  return best;
}

const categoryOf = (key) => { const ou = key.match(/^(.+)_(over|under)\d+_5$/); return ou ? `${ou[1]}-${ou[2]}` : key; };
// Familia de DATOS para vetar categorías sin cobertura real (goles/resultado/derivadas → null, nunca se vetan).
function dataCategoryOf(key) {
  if (/corner/.test(key))   return 'corners';
  if (/card/.test(key))     return 'cards';
  if (/sot/.test(key))      return 'sot';
  if (/shot/.test(key))     return 'shots';
  if (/foul/.test(key))     return 'fouls';
  if (/offside/.test(key))  return 'offsides';
  return null;
}

// ── combinada: MISMA shape que buildContextCombinada (selections/selectable/_funnel) ──
// playerMarkets: salida de buildPlayerMarkets (Etapa 3) — reemplaza la ruta playerHighlights.
export function buildModelCombinada(scored, odds, teamNames, playerMarkets, probabilities, statsData) {
  const allBks = odds?.allBookmakerOdds;
  const avail = statsData ? availabilityFromStats(statsData) : (probabilities?.cornerCardData?.dataAvailability || {});
  const blockedByData = (key) => { const c = dataCategoryOf(key); return c != null && avail[c] !== true; };

  // Player props del MODELO (freq≥70%) con cuota real ≥1.20 atribuida a bookmaker.
  const PLAYER_MIN_PROB = 70;
  const playerSel = [];
  for (const sel of playerMarketsToSelections(playerMarkets)) {
    if (sel.probability < PLAYER_MIN_PROB) continue;
    const o = playerOddFor(sel, allBks);
    if (!o) continue;
    playerSel.push({ ...sel, odd: o.odd, bookmaker: o.bookmaker, confidence: undefined });
  }

  // Equipos recomendados (≥90% via scored.recommended) con cuota real.
  const teamSel = [];
  for (const [key, r] of Object.entries(scored)) {
    if (!r.recommended) continue;
    if (blockedByData(key)) continue;
    const o = oddFor(key, odds);
    if (!o) continue;
    teamSel.push({
      id: key, category: categoryOf(key), scope: 'context',
      name: marketLabel(key, teamNames), probability: clampPct(r.prob_final * 100),
      odd: o.odd, bookmaker: o.bookmaker,
      level: r.level, confidence: Math.round((r.confidence || 0) * 100), sampleN: r.n,
    });
  }
  const selected = [...teamSel, ...playerSel].filter(m => m.odd > MIN_ODD - 1e-9).sort((a, b) => b.probability - a.probability);

  // Seleccionables (acordeón): TODO ≥70% con cuota real ≥1.20 (sin exigir recommended).
  const SELECTABLE_MIN_PROB = 0.70;
  const teamSelectable = [];
  let fScored = 0, fGe70 = 0, fGe70NoOdds = 0, fNoData = 0;
  for (const [key, r] of Object.entries(scored)) {
    fScored++;
    if (blockedByData(key)) { fNoData++; continue; }
    const p = r.prob_final;
    if (p == null || p < SELECTABLE_MIN_PROB) continue;
    fGe70++;
    const o = oddFor(key, odds);
    if (!o) { fGe70NoOdds++; continue; }
    teamSelectable.push({
      id: key, category: categoryOf(key), scope: 'context',
      name: marketLabel(key, teamNames), probability: clampPct(p * 100),
      odd: o.odd, bookmaker: o.bookmaker, level: r.level, recommended: !!r.recommended,
    });
  }
  const selectable = [...teamSelectable, ...playerSel].filter(m => m.odd > MIN_ODD - 1e-9).sort((a, b) => b.probability - a.probability);

  const _funnel = {
    scored: fScored, ge70: fGe70, ge70_sinCuota: fGe70NoOdds, sinDatos: fNoData,
    teamSelectable: teamSelectable.length, playerSelectable: playerSel.length, selectable: selectable.length,
  };

  if (!selected.length) {
    return { selections: [], selectable, _funnel, combinedOdd: null, combinedProbability: 0, highRisk: false, hasRealOdds: selectable.length > 0, threshold: 90, source: 'context-engine' };
  }
  const combinedOdd = selected.reduce((acc, m) => acc * m.odd, 1);
  const combinedProbability = selected.reduce((acc, m) => acc * (m.probability / 100), 1) * 100;
  return {
    selections: selected, selectable, _funnel,
    combinedOdd: +combinedOdd.toFixed(2),
    combinedProbability: +combinedProbability.toFixed(1),
    highRisk: combinedProbability < 60, hasRealOdds: true,
    threshold: Math.min(...selected.map(m => m.probability)), source: 'context-engine',
  };
}
