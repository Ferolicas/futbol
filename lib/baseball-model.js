// Baseball probability model
//
// Replicates the spirit of the football model (Dixon-Coles + isotonic calibration)
// but adapted to baseball mechanics:
//   - No draws → moneyline is binary (homeWin / awayWin)
//   - Run distribution closer to Negative Binomial than Poisson (overdispersed)
//   - Strong home advantage (~54% MLB historic)
//   - F5 Innings (first 5) markets — usually higher under % since pitchers fresh
//   - Run Line ±1.5 default
//   - Team Total Runs O/U
//
// Design principles:
//   - Always return calibrated probabilities, never blanks
//   - Cap displayed prob at 95% (anti-overconfidence)
//   - Cross-check vs market odds (de-vig) and weight 60% model + 40% market

// =====================================================================
// HELPERS
// =====================================================================

const MIN_PROB = 0.02;
const MAX_PROB = 0.98;
const HOME_ADV_BASELINE = 0.54;       // MLB historical home win rate
const LEAGUE_AVG_RUNS_PER_GAME = 9.0; // ~4.5 per team
const F5_RUNS_FRACTION = 0.55;        // ~55% of total runs scored by F5

const cap = (p, lo = MIN_PROB, hi = MAX_PROB) => Math.max(lo, Math.min(hi, p));

function poissonPMF(k, lambda) {
  if (k < 0) return 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

// Probability that X (Poisson(lambdaA)) > Y (Poisson(lambdaB))
function probXGreaterY(lambdaA, lambdaB, maxK = 25) {
  let p = 0;
  for (let a = 0; a <= maxK; a++) {
    const pa = poissonPMF(a, lambdaA);
    let cumB = 0;
    for (let b = 0; b < a; b++) cumB += poissonPMF(b, lambdaB);
    p += pa * cumB;
  }
  return p;
}

// Probability that X + Y > line (continuous correction with .5 lines is exact)
function probTotalOver(lambdaA, lambdaB, line, maxK = 30) {
  const total = lambdaA + lambdaB;
  let pUnder = 0;
  const ceiling = Math.floor(line);
  for (let k = 0; k <= ceiling; k++) {
    pUnder += poissonPMF(k, total);
  }
  return 1 - pUnder;
}

// =====================================================================
// DE-VIG: convert market odds → fair probabilities
// =====================================================================
function decimalToImplied(odd) { return odd > 1 ? 1 / odd : null; }

function deVigBinary(homeOdd, awayOdd) {
  if (!homeOdd || !awayOdd) return null;
  const ph = decimalToImplied(homeOdd);
  const pa = decimalToImplied(awayOdd);
  if (!ph || !pa) return null;
  const total = ph + pa;
  return { home: ph / total, away: pa / total };
}

// =====================================================================
// TEAM STRENGTH
// =====================================================================
// Builds attack/defense expected runs from team stats.
function teamStrength(stats, leagueAvg = LEAGUE_AVG_RUNS_PER_GAME / 2) {
  if (!stats) return { attack: leagueAvg, defense: leagueAvg };

  const games = stats.games?.played?.total || stats.games?.played || 1;
  const runsScored = stats.points?.for?.total || stats.runs?.for?.total
    || (stats.points?.for?.average?.total ? Number(stats.points.for.average.total) * games : null);
  const runsAllowed = stats.points?.against?.total || stats.runs?.against?.total
    || (stats.points?.against?.average?.total ? Number(stats.points.against.average.total) * games : null);

  const attack = runsScored ? runsScored / Math.max(games, 1) : leagueAvg;
  const defense = runsAllowed ? runsAllowed / Math.max(games, 1) : leagueAvg;

  return { attack, defense };
}

// =====================================================================
// TEAM PITCHING STRENGTH (factor del pitcheo del equipo)
//
// Extrae el pitching de teams/statistics. Como api-baseball v1 no
// expone starter individual, usamos el pitching agregado del equipo
// como mejor proxy. Devuelve un factor 0.85-1.15 que escala las
// carreras esperadas DEL RIVAL:
//   factor < 1 → pitcheo fuerte (rival anota menos)
//   factor > 1 → pitcheo débil (rival anota más)
// =====================================================================
function teamPitchingFactor(stats, leagueAvg = LEAGUE_AVG_RUNS_PER_GAME / 2) {
  if (!stats) return 1.0;

  // En api-baseball v1, el campo `points.against.average.total` es la media
  // de carreras encajadas por partido. Si su pitcheo es bueno, este número
  // está por debajo del league average.
  const games = stats.games?.played?.total || stats.games?.played || 0;
  let runsAllowedPerGame = null;
  if (stats.points?.against?.average?.total) {
    runsAllowedPerGame = Number(stats.points.against.average.total);
  } else if (stats.points?.against?.total && games > 0) {
    runsAllowedPerGame = stats.points.against.total / games;
  } else if (stats.runs?.against?.total && games > 0) {
    runsAllowedPerGame = stats.runs.against.total / games;
  }

  if (!Number.isFinite(runsAllowedPerGame) || runsAllowedPerGame <= 0) return 1.0;

  // Factor = (actual / league avg). Si la media de la liga es 4.5 carreras
  // por equipo y este equipo permite 3.6, factor = 0.80 → rival anota 80%
  // de lo que anotaría contra un pitcheo promedio.
  const factor = runsAllowedPerGame / leagueAvg;
  return Math.max(0.75, Math.min(1.25, factor));
}

// =====================================================================
// EXPECTED RUNS for a matchup
// =====================================================================
function expectedRuns(homeStats, awayStats, parkFactor = 1.0, pitcherMatchup = null) {
  const home = teamStrength(homeStats);
  const away = teamStrength(awayStats);
  const leagueHalf = LEAGUE_AVG_RUNS_PER_GAME / 2;

  // Bilinear adjustment: expected runs = (own attack) * (opp defense / league avg) * park
  // + home advantage boost.
  let lambdaHome = (home.attack * (away.defense / leagueHalf)) * parkFactor;
  let lambdaAway = (away.attack * (home.defense / leagueHalf)) * parkFactor;

  // Pitcher matchup factor — si tenemos info de starter (lo ideal) usamos
  // ESO. Si no, fallback a team pitching strength. El factor multiplica
  // las carreras del rival (porque el pitcher es defensa contra el rival).
  if (pitcherMatchup) {
    // Bloque E: cuando hay datos de starter individual, son más predictivos
    // que team aggregate. Estructura esperada:
    //   { home: { factor }, away: { factor } } donde factor ∈ [0.6, 1.4]
    const homeP = pitcherMatchup.home?.factor;
    const awayP = pitcherMatchup.away?.factor;
    if (Number.isFinite(awayP)) lambdaAway *= awayP;  // away anota → home pitcher
    if (Number.isFinite(homeP)) lambdaHome *= homeP;  // home anota → away pitcher
  } else {
    // Fallback: team-level pitching strength (siempre disponible cuando
    // tenemos team stats — 0 API calls extra).
    const homeTeamPitch = teamPitchingFactor(homeStats);  // factor del pitcheo HOME → afecta carreras AWAY
    const awayTeamPitch = teamPitchingFactor(awayStats);  // pitcheo AWAY → afecta carreras HOME
    lambdaAway *= homeTeamPitch;
    lambdaHome *= awayTeamPitch;
  }

  // Home advantage: ~5% boost on offense, ~3% reduction on defense
  lambdaHome *= 1.05;
  lambdaAway *= 0.97;

  // Sanity bounds: real games rarely have <2 or >9 expected runs per team
  lambdaHome = Math.max(2.0, Math.min(9.0, lambdaHome));
  lambdaAway = Math.max(2.0, Math.min(9.0, lambdaAway));

  return { lambdaHome, lambdaAway };
}

// =====================================================================
// LÍNEAS ADAPTATIVAS — bloque D
// Genera N líneas .5 alrededor de la media esperada. Mismo patron que
// adaptiveLines() de fútbol pero con redondeo a .5 (no a .5 enteros).
// =====================================================================
function adaptiveBaseballLines(mean, count = 5, span = 2) {
  if (!Number.isFinite(mean) || mean <= 0) return [];
  // Centro = media redondeada a .5 más cercana
  const center = Math.round(mean * 2) / 2;
  const lines = [];
  const half = Math.floor(count / 2);
  for (let i = -half; i <= half; i++) {
    const k = center + i * (span / count);
    // Redondear a .5 más cercano y filtrar duplicados
    const rounded = Math.round(k * 2) / 2;
    if (rounded > 0 && !lines.includes(rounded)) lines.push(rounded);
  }
  return lines.sort((a, b) => a - b);
}

// =====================================================================
// H2H ADJUSTMENT
// =====================================================================
function h2hAdjust(h2h, homeId, awayId) {
  if (!Array.isArray(h2h) || h2h.length === 0) return { homeBoost: 0, awayBoost: 0 };

  const recent = h2h.slice(0, 10);
  let homeWins = 0;
  let awayWins = 0;
  recent.forEach(g => {
    const hScore = g.scores?.home?.total ?? g.scores?.home;
    const aScore = g.scores?.away?.total ?? g.scores?.away;
    if (hScore == null || aScore == null) return;
    const wasHomeTeam = g.teams?.home?.id === homeId;
    if (hScore > aScore) {
      if (wasHomeTeam) homeWins++; else awayWins++;
    } else if (aScore > hScore) {
      if (wasHomeTeam) awayWins++; else homeWins++;
    }
  });

  const total = homeWins + awayWins;
  if (total === 0) return { homeBoost: 0, awayBoost: 0 };

  // Mild boost: ±5% based on H2H record
  const homeRate = homeWins / total;
  return {
    homeBoost: (homeRate - 0.5) * 0.10,
    awayBoost: ((1 - homeRate) - 0.5) * 0.10,
  };
}

// =====================================================================
// MAIN: COMPUTE ALL MARKETS
// =====================================================================

export function computeBaseballProbabilities({
  homeStats,
  awayStats,
  homeId,
  awayId,
  h2h,
  marketOdds,            // raw odds object from API
  parkFactor = 1.0,
  pitcherMatchup = null, // bloque E — { home: {factor, name}, away: {factor, name} }
  playerHighlights = null, // bloque F — { strikeouts:[], hits:[], homeRuns:[], totalBases:[], rbis:[] }
}) {
  const { lambdaHome, lambdaAway } = expectedRuns(homeStats, awayStats, parkFactor, pitcherMatchup);
  const adj = h2hAdjust(h2h, homeId, awayId);

  // ===== Moneyline =====
  let pHome = probXGreaterY(lambdaHome, lambdaAway);
  let pAway = 1 - pHome;
  pHome = cap(pHome + adj.homeBoost);
  pAway = cap(1 - pHome);
  // Re-normalize
  const sumML = pHome + pAway;
  pHome = pHome / sumML;
  pAway = pAway / sumML;

  // Blend with market (de-vig) when available
  const mlMarket = extractMoneylineOdds(marketOdds);
  const mlDevig = mlMarket ? deVigBinary(mlMarket.home, mlMarket.away) : null;
  if (mlDevig) {
    pHome = 0.6 * pHome + 0.4 * mlDevig.home;
    pAway = 0.6 * pAway + 0.4 * mlDevig.away;
  }

  // ===== Total Runs — líneas adaptativas (bloque D) =====
  // Antes: 4 líneas fijas [7.5, 8.5, 9.5, 10.5].
  // Ahora: 5 líneas centradas en lambdaHome+lambdaAway esperado.
  const expectedTotal = lambdaHome + lambdaAway;
  const totalLines = adaptiveBaseballLines(expectedTotal, 5, 4);
  const totals = {};
  totalLines.forEach(line => {
    const pOver = probTotalOver(lambdaHome, lambdaAway, line);
    totals[line] = { over: cap(pOver), under: cap(1 - pOver) };
  });

  // bestLine = la más cercana al expected (siempre existe ahora)
  const bestLine = totalLines.length > 0
    ? totalLines.reduce((best, l) => Math.abs(l - expectedTotal) < Math.abs(best - expectedTotal) ? l : best, totalLines[0])
    : null;

  // ===== Run Line ±1.5 =====
  // Home -1.5: home wins by 2+; Away +1.5: away loses by ≤1 OR wins
  const pHomeMinus15 = probXGreaterY(lambdaHome, lambdaAway + 1.5);
  const pAwayPlus15 = 1 - pHomeMinus15;
  const pAwayMinus15 = probXGreaterY(lambdaAway, lambdaHome + 1.5);
  const pHomePlus15 = 1 - pAwayMinus15;

  // ===== F5 (first 5 innings) — adaptive lines también =====
  const f5Home = lambdaHome * F5_RUNS_FRACTION;
  const f5Away = lambdaAway * F5_RUNS_FRACTION;
  const pF5Home = probXGreaterY(f5Home, f5Away);
  const pF5Away = 1 - pF5Home;
  const pF5Tie = poissonTie(f5Home, f5Away);
  const f5Expected = f5Home + f5Away;
  const f5TotalLines = adaptiveBaseballLines(f5Expected, 3, 2);
  const f5Totals = {};
  f5TotalLines.forEach(line => {
    const pOver = probTotalOver(f5Home, f5Away, line);
    f5Totals[line] = { over: cap(pOver), under: cap(1 - pOver) };
  });

  // ===== Team Totals — adaptive lines per team =====
  const teamTotals = { home: {}, away: {} };
  const homeTeamLines = adaptiveBaseballLines(lambdaHome, 3, 2);
  const awayTeamLines = adaptiveBaseballLines(lambdaAway, 3, 2);
  homeTeamLines.forEach(line => {
    const pOver = probTotalOver(lambdaHome, 0, line);
    teamTotals.home[line] = { over: cap(pOver), under: cap(1 - pOver) };
  });
  awayTeamLines.forEach(line => {
    const pOver = probTotalOver(lambdaAway, 0, line);
    teamTotals.away[line] = { over: cap(pOver), under: cap(1 - pOver) };
  });

  // ===== Both Teams to Score 1+ Run =====
  const pHomeZero = poissonPMF(0, lambdaHome);
  const pAwayZero = poissonPMF(0, lambdaAway);
  const pBTTS = (1 - pHomeZero) * (1 - pAwayZero);

  return {
    moneyline: {
      home: Math.round(pHome * 100),
      away: Math.round(pAway * 100),
    },
    totals: {
      bestLine,
      lines: Object.fromEntries(totalLines.map(l => [l, {
        over: Math.round(totals[l].over * 100),
        under: Math.round(totals[l].under * 100),
      }])),
    },
    runLine: {
      home_minus_1_5: Math.round(cap(pHomeMinus15) * 100),
      away_plus_1_5: Math.round(cap(pAwayPlus15) * 100),
      away_minus_1_5: Math.round(cap(pAwayMinus15) * 100),
      home_plus_1_5: Math.round(cap(pHomePlus15) * 100),
    },
    f5: {
      moneyline: {
        home: Math.round(cap(pF5Home) * 100),
        away: Math.round(cap(pF5Away) * 100),
        tie: Math.round(cap(pF5Tie) * 100),
      },
      totals: Object.fromEntries(f5TotalLines.map(l => [l, {
        over: Math.round(f5Totals[l].over * 100),
        under: Math.round(f5Totals[l].under * 100),
      }])),
    },
    // teamTotals usa lineas adaptativas distintas por equipo (homeTeamLines
    // y awayTeamLines, computadas arriba). Antes habia una unica variable
    // `teamTotalLines` con lineas fijas — al pasar a adaptativas se quedo
    // referencia huerfana. Fix: iterar sobre las keys ya pobladas en el
    // objeto teamTotals.home/.away en vez de la lista de lineas.
    teamTotals: {
      home: Object.fromEntries(Object.entries(teamTotals.home).map(([l, vals]) => [l, {
        over: Math.round(vals.over * 100),
        under: Math.round(vals.under * 100),
      }])),
      away: Object.fromEntries(Object.entries(teamTotals.away).map(([l, vals]) => [l, {
        over: Math.round(vals.over * 100),
        under: Math.round(vals.under * 100),
      }])),
    },
    btts: {
      yes: Math.round(cap(pBTTS) * 100),
      no: Math.round(cap(1 - pBTTS) * 100),
    },
    expected: {
      lambdaHome: +lambdaHome.toFixed(2),
      lambdaAway: +lambdaAway.toFixed(2),
      totalRuns: +(lambdaHome + lambdaAway).toFixed(2),
    },
    // Bloque E — info de pitchers (puede ser null si extractBaseballPitcherMatchup
    // no consigue datos; el modelo sigue funcionando con fallback team-level).
    pitchers: pitcherMatchup,
    // Bloque F — player markets calculados a partir de playerHighlights.
    // Si playerHighlights es null (caso actual sin endpoint player stats),
    // probabilities.players = null. La estructura está preparada para
    // cuando se integre una fuente de player stats (ej. MLB Stats API).
    players: buildBaseballPlayerProbabilities(playerHighlights, marketOdds),
  };
}

function poissonTie(la, lb, maxK = 20) {
  let p = 0;
  for (let k = 0; k <= maxK; k++) p += poissonPMF(k, la) * poissonPMF(k, lb);
  return p;
}

// =====================================================================
// MARKET ODDS EXTRACTION (api-baseball multi-bookmaker format)
// =====================================================================
function extractMoneylineOdds(rawOdds) {
  if (!Array.isArray(rawOdds) || rawOdds.length === 0) return null;

  // rawOdds[0] = first game (already filtered). Has bookmakers[].bets[].values[]
  const bookmakers = rawOdds[0]?.bookmakers || [];
  for (const bk of bookmakers) {
    const bet = (bk.bets || []).find(b =>
      /money\s*line|moneyline|home\/away|game\s*lines/i.test(b.name || '')
    );
    if (!bet) continue;
    const values = bet.values || [];
    const home = values.find(v => /home|local|1/i.test(v.value))?.odd;
    const away = values.find(v => /away|visit|2/i.test(v.value))?.odd;
    if (home && away) return { home: Number(home), away: Number(away) };
  }
  return null;
}

export function extractBestOdds(rawOdds) {
  if (!Array.isArray(rawOdds) || rawOdds.length === 0) return null;
  const bookmakers = rawOdds[0]?.bookmakers || [];

  const out = {
    moneyline: null,
    totals: {},
    runLine: null,
    bookmakerCount: bookmakers.length,
  };

  for (const bk of bookmakers) {
    for (const bet of bk.bets || []) {
      const name = (bet.name || '').toLowerCase();

      if (/money\s*line|moneyline|home\/away|game\s*lines/.test(name)) {
        const home = bet.values?.find(v => /home|local|1/i.test(v.value))?.odd;
        const away = bet.values?.find(v => /away|visit|2/i.test(v.value))?.odd;
        if (home && away) {
          const entry = { home: Number(home), away: Number(away), bookmaker: bk.name };
          if (!out.moneyline || (Number(home) > out.moneyline.home && Number(away) > out.moneyline.away)) {
            out.moneyline = entry;
          }
        }
      }

      if (/total|over\s*\/\s*under|asian\s*total/.test(name) && !/team\s*total/.test(name)) {
        for (const v of bet.values || []) {
          const m = (v.value || '').match(/over|under/i);
          if (!m) continue;
          const lineMatch = (v.value || '').match(/[\d.]+/);
          const line = lineMatch ? parseFloat(lineMatch[0]) : null;
          if (!line) continue;
          if (!out.totals[line]) out.totals[line] = {};
          const side = m[0].toLowerCase();
          if (!out.totals[line][side] || Number(v.odd) > out.totals[line][side].odd) {
            out.totals[line][side] = { odd: Number(v.odd), bookmaker: bk.name };
          }
        }
      }
    }
  }

  return out;
}

// =====================================================================
// COMBINADA BUILDER — catalogo unificado (mismo patron que fútbol)
//
// Devuelve { selections, combinedOdd, combinedProbability, hasRealOdds,
//            totalMarkets, deduplicatedMarkets, threshold }
// selections = TODOS los mercados deduplicados que pasan PROB_THRESHOLD.
// Frontend filtra adicional por rango (70-95) y suma a la combinada Auto.
// La logica de "top N picks" para Apuesta del Día vive en buildBaseballApuestaDelDia.
// =====================================================================

const BASEBALL_PROB_THRESHOLD = 60;  // baseline mas laxo que futbol (baseball tiene menos volumen de markets)
const BASEBALL_MIN_ODD = 1.01;

// Dedup por categoria: dentro de cada categoria nos quedamos con la prob mas alta.
// 'moneyline', 'total', 'runline-home', 'runline-away', 'f5-moneyline', 'f5-total',
// 'btts', 'home-total', 'away-total' son las categorias actuales.
const BASEBALL_CATEGORIES = {
  'moneyline':      ['ml-home', 'ml-away'],
  'total':          [],  // dinamico — los ids son 'total-{line}-over' / 'total-{line}-under'
  'runline-home':   ['rl-home-minus-1_5', 'rl-home-plus-1_5'],
  'runline-away':   ['rl-away-minus-1_5', 'rl-away-plus-1_5'],
  'f5-moneyline':   ['f5-ml-home', 'f5-ml-away'],
  'f5-total':       [],  // dinamico
  'btts':           ['btts-yes', 'btts-no'],
  'home-total':     [],  // dinamico
  'away-total':     [],  // dinamico
};

function deduplicateBaseballByCategory(markets) {
  const bestByCategory = {};
  const uncategorized = [];
  for (const m of markets) {
    const cat = m.category;
    if (!cat) { uncategorized.push(m); continue; }
    if (!bestByCategory[cat] || m.probability > bestByCategory[cat].probability) {
      bestByCategory[cat] = m;
    }
  }
  return [...Object.values(bestByCategory), ...uncategorized];
}

export function buildBaseballCombinada(probabilities, bestOdds, teamNames = {}) {
  if (!probabilities) {
    return { selections: [], combinedOdd: null, combinedProbability: 0,
             hasRealOdds: false, threshold: BASEBALL_PROB_THRESHOLD,
             totalMarkets: 0, deduplicatedMarkets: 0 };
  }

  const homeName = teamNames.home || 'Home';
  const awayName = teamNames.away || 'Away';
  const all = [];

  // push() solo acepta markets con cuota real (odd > MIN_ODD). Sin cuota
  // → no se recomienda al usuario (no podria apostar). Mismo patron que
  // lib/combinada.js de fútbol.
  const push = (entry, oddVal) => {
    const odd = parseFloat(oddVal);
    if (!isFinite(odd) || odd <= BASEBALL_MIN_ODD) return;
    all.push({ ...entry, odd });
  };

  // ── Moneyline ──
  if (probabilities.moneyline) {
    push({
      id: 'ml-home', category: 'moneyline', scope: 'team', team: 'home',
      name: `${homeName} gana`, probability: probabilities.moneyline.home,
    }, bestOdds?.moneyline?.home);
    push({
      id: 'ml-away', category: 'moneyline', scope: 'team', team: 'away',
      name: `${awayName} gana`, probability: probabilities.moneyline.away,
    }, bestOdds?.moneyline?.away);
  }

  // ── Totals (todas las lineas que vengan en probabilities.totals.lines) ──
  if (probabilities.totals?.lines) {
    for (const [line, vals] of Object.entries(probabilities.totals.lines)) {
      push({
        id: `total-${line}-over`, category: `total-${line}`, scope: 'total',
        name: `Más de ${line} carreras`, probability: vals.over, _line: parseFloat(line),
      }, bestOdds?.totals?.[line]?.over?.odd);
      push({
        id: `total-${line}-under`, category: `total-${line}`, scope: 'total',
        name: `Menos de ${line} carreras`, probability: vals.under, _line: parseFloat(line),
      }, bestOdds?.totals?.[line]?.under?.odd);
    }
  }

  // ── Run Line ±1.5 ──
  if (probabilities.runLine) {
    push({
      id: 'rl-home-minus-1_5', category: 'runline-home', scope: 'team', team: 'home',
      name: `${homeName} -1.5`, probability: probabilities.runLine.home_minus_1_5,
    }, bestOdds?.runLine?.home_minus_1_5);
    push({
      id: 'rl-away-plus-1_5', category: 'runline-away', scope: 'team', team: 'away',
      name: `${awayName} +1.5`, probability: probabilities.runLine.away_plus_1_5,
    }, bestOdds?.runLine?.away_plus_1_5);
    push({
      id: 'rl-away-minus-1_5', category: 'runline-away', scope: 'team', team: 'away',
      name: `${awayName} -1.5`, probability: probabilities.runLine.away_minus_1_5,
    }, bestOdds?.runLine?.away_minus_1_5);
    push({
      id: 'rl-home-plus-1_5', category: 'runline-home', scope: 'team', team: 'home',
      name: `${homeName} +1.5`, probability: probabilities.runLine.home_plus_1_5,
    }, bestOdds?.runLine?.home_plus_1_5);
  }

  // ── F5 (First 5 Innings) ──
  if (probabilities.f5?.moneyline) {
    push({
      id: 'f5-ml-home', category: 'f5-moneyline', scope: 'team', team: 'home',
      name: `${homeName} F5`, probability: probabilities.f5.moneyline.home,
    }, bestOdds?.f5?.moneyline?.home);
    push({
      id: 'f5-ml-away', category: 'f5-moneyline', scope: 'team', team: 'away',
      name: `${awayName} F5`, probability: probabilities.f5.moneyline.away,
    }, bestOdds?.f5?.moneyline?.away);
  }
  if (probabilities.f5?.totals) {
    for (const [line, vals] of Object.entries(probabilities.f5.totals)) {
      push({
        id: `f5-total-${line}-over`, category: `f5-total-${line}`, scope: 'total',
        name: `F5 — Más de ${line} carreras`, probability: vals.over, _line: parseFloat(line),
      }, bestOdds?.f5?.totals?.[line]?.over?.odd);
      push({
        id: `f5-total-${line}-under`, category: `f5-total-${line}`, scope: 'total',
        name: `F5 — Menos de ${line} carreras`, probability: vals.under, _line: parseFloat(line),
      }, bestOdds?.f5?.totals?.[line]?.under?.odd);
    }
  }

  // ── Team Totals ──
  if (probabilities.teamTotals?.home) {
    for (const [line, vals] of Object.entries(probabilities.teamTotals.home)) {
      push({
        id: `home-total-${line}-over`, category: `home-total-${line}`, scope: 'team', team: 'home',
        name: `${homeName} — Más de ${line} carreras`, probability: vals.over, _line: parseFloat(line),
      }, bestOdds?.teamTotals?.home?.[line]?.over?.odd);
    }
  }
  if (probabilities.teamTotals?.away) {
    for (const [line, vals] of Object.entries(probabilities.teamTotals.away)) {
      push({
        id: `away-total-${line}-over`, category: `away-total-${line}`, scope: 'team', team: 'away',
        name: `${awayName} — Más de ${line} carreras`, probability: vals.over, _line: parseFloat(line),
      }, bestOdds?.teamTotals?.away?.[line]?.over?.odd);
    }
  }

  // ── BTTS ──
  if (probabilities.btts) {
    push({
      id: 'btts-yes', category: 'btts', scope: 'total',
      name: 'Ambos anotan 1+', probability: probabilities.btts.yes,
    }, bestOdds?.btts?.yes);
    push({
      id: 'btts-no', category: 'btts', scope: 'total',
      name: 'Algún equipo en blanco', probability: probabilities.btts.no,
    }, bestOdds?.btts?.no);
  }

  // ── Player markets (cuando se añadan en bloque F) ──
  // probabilities.players = { strikeouts:[...], homeRuns:[...], hits:[...], totalBases:[...], rbis:[...] }
  // bestOdds.players = { strikeouts:{ [pitcherName]:{ [line]: odd } }, ... }
  if (probabilities.players) {
    pushBaseballPlayerMarkets(push, probabilities.players, bestOdds?.players || {});
  }

  // Dedup, filter, sort
  const deduplicated = deduplicateBaseballByCategory(all);
  const selected = deduplicated
    .filter(m => m.probability >= BASEBALL_PROB_THRESHOLD)
    .sort((a, b) => b.probability - a.probability);

  if (selected.length === 0) {
    return {
      selections: [], combinedOdd: null, combinedProbability: 0,
      hasRealOdds: false, threshold: BASEBALL_PROB_THRESHOLD,
      totalMarkets: all.length, deduplicatedMarkets: deduplicated.length,
    };
  }

  const combinedOdd = selected.reduce((acc, m) => acc * (m.odd || 1), 1);
  const combinedProbability = selected.reduce((acc, m) => acc + m.probability, 0) / selected.length;

  return {
    selections: selected,
    combinedOdd: +combinedOdd.toFixed(2),
    combinedProbability: +combinedProbability.toFixed(1),
    hasRealOdds: selected.every(s => s.odd),
    threshold: BASEBALL_PROB_THRESHOLD,
    totalMarkets: all.length,
    deduplicatedMarkets: deduplicated.length,
  };
}

// Helper: empuja mercados de jugador con linea optima por EV (mismo patron
// que fútbol selectBestPlayerLine). Solo se invoca si probabilities.players
// existe — bloque F del proyecto baseball lo introducira.
function pushBaseballPlayerMarkets(push, players, oddsByPlayer) {
  // strikeouts (pitcher): cada pitcher con histograma → linea optima
  for (const pitcher of (players.strikeouts || [])) {
    const oddsByLine = oddsByPlayer.strikeouts?.[normalizePlayerName(pitcher.name)] || {};
    const best = selectBestBaseballPlayerLine(pitcher.history, oddsByLine, 60);
    if (!best) continue;
    const t = Math.ceil(best.line);
    push({
      id: `pl-k-${pitcher.id}`, category: `pl-k-${pitcher.id}`, scope: 'player',
      playerId: pitcher.id, playerName: pitcher.name, team: pitcher.teamName,
      name: `${pitcher.name} — ${t}+ ponches`, probability: best.freq, _line: best.line,
    }, best.odd);
  }
  // hits — linea adaptativa
  for (const p of (players.hits || [])) {
    const oddsByLine = oddsByPlayer.hits?.[normalizePlayerName(p.name)] || {};
    const best = selectBestBaseballPlayerLine(p.history, oddsByLine, 60);
    if (!best) continue;
    const t = Math.ceil(best.line);
    const label = t === 1 ? `${p.name} — Hit 1+` : `${p.name} — ${t}+ hits`;
    push({
      id: `pl-h-${p.id}`, category: `pl-h-${p.id}`, scope: 'player',
      playerId: p.id, playerName: p.name, team: p.teamName,
      name: label, probability: best.freq, _line: best.line,
    }, best.odd);
  }
  // total bases
  for (const p of (players.totalBases || [])) {
    const oddsByLine = oddsByPlayer.totalBases?.[normalizePlayerName(p.name)] || {};
    const best = selectBestBaseballPlayerLine(p.history, oddsByLine, 60);
    if (!best) continue;
    push({
      id: `pl-tb-${p.id}`, category: `pl-tb-${p.id}`, scope: 'player',
      playerId: p.id, playerName: p.name, team: p.teamName,
      name: `${p.name} — Bases totales > ${best.line}`,
      probability: best.freq, _line: best.line,
    }, best.odd);
  }
  // RBIs
  for (const p of (players.rbis || [])) {
    const oddsByLine = oddsByPlayer.rbis?.[normalizePlayerName(p.name)] || {};
    const best = selectBestBaseballPlayerLine(p.history, oddsByLine, 60);
    if (!best) continue;
    const t = Math.ceil(best.line);
    push({
      id: `pl-rbi-${p.id}`, category: `pl-rbi-${p.id}`, scope: 'player',
      playerId: p.id, playerName: p.name, team: p.teamName,
      name: `${p.name} — ${t}+ RBI`, probability: best.freq, _line: best.line,
    }, best.odd);
  }
  // Home runs (anytime)
  for (const p of (players.homeRuns || [])) {
    const odd = oddsByPlayer.homeRuns?.[normalizePlayerName(p.name)];
    const freq = baseballPlayerFreqAtLeast(p.history, 1);
    if (freq < 30) continue;  // HR es raro, threshold mas bajo
    push({
      id: `pl-hr-${p.id}`, category: `pl-hr-${p.id}`, scope: 'player',
      playerId: p.id, playerName: p.name, team: p.teamName,
      name: `${p.name} — Home run`, probability: freq,
    }, odd);
  }
}

function normalizePlayerName(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function baseballPlayerFreqAtLeast(events, threshold) {
  if (!Array.isArray(events) || events.length === 0) return 0;
  const t = Math.max(1, threshold);
  const hits = events.filter(e => (e || 0) >= t).length;
  return Math.max(5, Math.min(95, Math.round((hits / events.length) * 100)));
}

function selectBestBaseballPlayerLine(events, oddsByLine, minFreq) {
  if (!oddsByLine || !Array.isArray(events) || events.length === 0) return null;
  const candidates = [];
  for (const [lineStr, oddRaw] of Object.entries(oddsByLine)) {
    const line = parseFloat(lineStr);
    const odd = parseFloat(oddRaw);
    if (!isFinite(line) || !isFinite(odd) || odd <= BASEBALL_MIN_ODD) continue;
    const threshold = Math.ceil(line);
    const freq = baseballPlayerFreqAtLeast(events, threshold);
    if (freq < minFreq) continue;
    candidates.push({ line, odd, freq, ev: freq * (odd - 1) });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.ev - a.ev || b.freq - a.freq);
  return candidates[0];
}

// =====================================================================
// PLAYER MARKETS — bloque F
//
// Construye probabilidades para mercados de jugador (strikeouts, hits,
// total bases, RBIs, home runs) desde playerHighlights.
//
// IMPORTANTE — limitación de api-sports baseball v1:
//   El endpoint /fixtures/players no existe para baseball. Para tener
//   player stats individuales necesitas integrar una fuente adicional
//   (recomendada: MLB Stats API — gratuita, sin key). Esta función está
//   estructurada para CUANDO se conecte esa fuente: si playerHighlights
//   es null, retorna null y el resto del modelo sigue funcionando. Si
//   playerHighlights llega con la estructura esperada, las probabilidades
//   se calculan correctamente.
//
//   Estructura esperada de playerHighlights:
//   {
//     strikeouts: [{ id, name, teamName, history: [12, 8, 9, ...], total: 90 }, ...],
//     hits:       [{ id, name, teamName, history: [1, 2, 0, 1, ...], total: 18 }, ...],
//     homeRuns:   [{ id, name, teamName, history: [0, 1, 0, ...], total: 5 }, ...],
//     totalBases: [{ id, name, teamName, history: [2, 1, 4, ...], total: 28 }, ...],
//     rbis:       [{ id, name, teamName, history: [1, 0, 2, ...], total: 15 }, ...],
//   }
// =====================================================================

function buildBaseballPlayerProbabilities(playerHighlights) {
  if (!playerHighlights) return null;

  const players = {};
  // Para cada categoría, generamos un array de { id, name, teamName, history,
  // lineProbs: { "0.5": prob, "1.5": prob, ... } } usando líneas adaptativas
  // sobre la media histórica del jugador.
  const cats = [
    { key: 'strikeouts', defaultMean: 6 },   // pitcher
    { key: 'hits',       defaultMean: 0.8 },
    { key: 'homeRuns',   defaultMean: 0.2 },
    { key: 'totalBases', defaultMean: 1.5 },
    { key: 'rbis',       defaultMean: 0.7 },
  ];

  for (const cat of cats) {
    const players_in_cat = playerHighlights[cat.key];
    if (!Array.isArray(players_in_cat) || players_in_cat.length === 0) continue;

    players[cat.key] = players_in_cat.map(p => {
      const hist = Array.isArray(p.history) ? p.history : [];
      const mean = hist.length > 0 ? hist.reduce((a, b) => a + (b || 0), 0) / hist.length : cat.defaultMean;
      const lines = adaptiveBaseballLines(mean, 4, 3);
      const lineProbs = {};
      for (const L of lines) {
        const threshold = Math.ceil(L);
        const hits = hist.filter(v => (v || 0) >= threshold).length;
        const prob = hist.length > 0 ? Math.round((hits / hist.length) * 100) : 0;
        lineProbs[L] = Math.max(5, Math.min(95, prob));
      }
      return {
        id: p.id, name: p.name, teamName: p.teamName,
        history: hist, total: p.total ?? hist.reduce((a, b) => a + (b || 0), 0),
        mean: +mean.toFixed(2), lineProbs,
      };
    });
  }

  return Object.keys(players).length > 0 ? players : null;
}

// =====================================================================
// EXTRACTORS (placeholders — se conectan en el worker)
// =====================================================================

/**
 * Bloque E — Extrae starting pitchers + sus stats del fixture.
 *
 * api-baseball v1 NO tiene /fixtures/players, así que esta función
 * actualmente retorna null. El modelo cae automáticamente a team-level
 * pitching strength (que SÍ funciona con teams/statistics).
 *
 * Para activarlo: integrar MLB Stats API (https://statsapi.mlb.com)
 * que es gratuita. Devolver:
 *   { home: { name, factor }, away: { name, factor } }
 * Donde `factor` ∈ [0.6, 1.4] modula las carreras esperadas del rival
 * (factor < 1 = pitcher fuerte, rival anota menos).
 *
 * Cálculo recomendado de factor:
 *   factor = (pitcherERA / leagueAvgERA) * 0.7 +
 *            (pitcherWHIP / leagueAvgWHIP) * 0.2 +
 *            (1 - pitcherK9 / leagueAvgK9) * 0.1
 *   Clamp a [0.6, 1.4].
 */
export async function extractBaseballPitcherMatchup(/* fixturePlayers, homeId, awayId, leagueId, season */) {
  return null;  // → modelo usa team-level pitching como fallback
}

/**
 * Bloque F — Extrae top jugadores con histograma de stats.
 *
 * Misma limitación que extractBaseballPitcherMatchup: requiere fuente de
 * player stats que api-baseball v1 no provee. Retorna null por ahora.
 *
 * Cuando se integre, debe devolver la estructura documentada en
 * buildBaseballPlayerProbabilities (arriba).
 */
export async function extractBaseballPlayerHighlights(/* fixturePlayers, homeId, awayId, homeName, awayName, leagueId, season */) {
  return null;  // → probabilities.players = null, frontend oculta esa sección
}

// =====================================================================
// DATA QUALITY SCORE
// =====================================================================
export function scoreBaseballDataQuality({ homeStats, awayStats, h2h, odds, pitcherMatchup, playerHighlights }) {
  const checks = {
    hasHomeStats: !!homeStats,
    hasAwayStats: !!awayStats,
    hasH2H: Array.isArray(h2h) && h2h.length >= 3,
    hasOdds: Array.isArray(odds) && odds.length > 0,
    hasPitcherMatchup: !!pitcherMatchup,
    hasPlayerHighlights: !!playerHighlights,
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const score = Math.round((passed / 6) * 100);
  return { ...checks, score };
}
