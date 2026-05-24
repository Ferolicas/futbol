// ──────────────────────────────────────────────────────────────────────────
// Tournament bracket Monte Carlo simulator.
//
// Dada una liga de copa con eliminatorias, simula N veces el bracket usando
// las probabilidades del modelo Dixon-Coles para cada partido pendiente, y
// agrega:
//   - P(equipo X avanza a la siguiente ronda)
//   - P(equipo X llega a la final)
//   - P(equipo X es campeon)
//
// Aplicable a:
//   - UEFA Champions League (R16 → QF → SF → F)  [leagueId 2]
//   - UEFA Europa League                          [leagueId 3]
//   - UEFA Conference League                      [leagueId 848]
//   - CONMEBOL Libertadores                       [leagueId 13]
//   - CONMEBOL Sudamericana                       [leagueId 11]
//   - Copa del Rey                                [leagueId 143]
//   - FA Cup                                      [leagueId 45]
//   - DFB Pokal                                   [leagueId 81]
//   - Coppa Italia                                [leagueId 137]
//   - Coupe de France                             [leagueId 66]
//   - World Cup                                   [leagueId 1]
//   - Copa America, Eurocopa, etc.
//
// NO aplica a:
//   - Ligas regulares (no hay bracket, todos juegan todos)
//   - Tournaments con formato hibrido (grupos + knockout) — solo simulamos
//     la fase knockout.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Sortea ganador segun probabilidad de victoria del home (P entre 0 y 1).
 * El draw % se reparte 50/50 al sortear el resultado de la fase (penales
 * decidiran si el modelo dice empate).
 */
function sampleWinner(pHomeWin, pDraw) {
  const r = Math.random();
  if (r < pHomeWin) return 'home';
  if (r < pHomeWin + pDraw / 2) return 'home';  // empate → 50/50
  return 'away';
}

/**
 * Avanza una sola ronda. matches es array de { teamA, teamB, pAWins, pDraw }.
 * Devuelve array de winners en mismo orden.
 */
function simulateRound(matches) {
  const winners = [];
  for (const m of matches) {
    if (!m.teamA || !m.teamB) {
      // Bye o partido sin contrincante definido — el equipo que esta pasa
      winners.push(m.teamA || m.teamB || null);
      continue;
    }
    const win = sampleWinner(m.pAWins / 100, m.pDraw / 100);
    winners.push(win === 'home' ? m.teamA : m.teamB);
  }
  return winners;
}

/**
 * Empareja winners de una ronda en partidos de la siguiente.
 * Asume estructura clasica: [w1, w2, w3, w4] → [(w1,w2), (w3,w4)].
 */
function pairNextRound(winners) {
  const matches = [];
  for (let i = 0; i < winners.length; i += 2) {
    matches.push({ teamA: winners[i], teamB: winners[i + 1] || null });
  }
  return matches;
}

/**
 * Calcula probabilidades 1X2 entre 2 teams usando snapshot de match_predictions
 * o, si no esta disponible, devuelve un default igualitario.
 *
 * @param {Map} predictionsMap — Map<fixtureId, { p_home_win, p_draw, p_away_win, ... }>
 * @param {number} teamAId, teamBId
 * @returns {{ pAWins, pDraw }} en porcentaje (0-100)
 */
function getMatchProbabilities(predictionsMap, fixtureId) {
  const p = predictionsMap?.get?.(fixtureId);
  if (!p) {
    // No tenemos prediccion → default 40/25/35 (leve favorito home)
    return { pAWins: 40, pDraw: 25 };
  }
  return {
    pAWins: p.p_home_win ?? 40,
    pDraw:  p.p_draw     ?? 25,
  };
}

/**
 * Simulacion Monte Carlo del bracket.
 *
 * @param {Array} initialBracket — [{ fixtureId, teamA: {id, name, logo}, teamB }]
 *                                  Solo el bracket DESDE el partido actual.
 *                                  Para partidos ya jugados, pasar ganador en
 *                                  el campo `winner` y omitir teamA/teamB.
 * @param {Map} predictionsMap — Map<fixtureId, predRow> de match_predictions
 * @param {number} iterations — default 10000
 * @returns {{ champion: {[teamId]: pct}, finalist: {...}, semis: {...} }}
 *   Probabilidades agregadas por equipo en cada ronda.
 */
export function simulateBracket(initialBracket, predictionsMap, iterations = 10000) {
  if (!Array.isArray(initialBracket) || initialBracket.length === 0) {
    return { champion: {}, finalist: {}, semis: {}, iterations: 0 };
  }

  // Construir array de matches del round actual (R16 / QF / SF / F).
  // Cada match tiene { teamA, teamB } y opcionalmente pAWins/pDraw del predictionsMap.
  function enrichMatches(matches) {
    return matches.map(m => {
      const { pAWins, pDraw } = getMatchProbabilities(predictionsMap, m.fixtureId);
      return { ...m, pAWins, pDraw };
    });
  }

  const matchesNow = enrichMatches(initialBracket);

  // Tally por ronda — ronda 0 = ahora, 1 = next, etc.
  // teamId → { atRound: [count_0, count_1, ...] }
  const tally = new Map();

  function incrTally(teamId, round) {
    if (!teamId?.id) return;
    let t = tally.get(teamId.id);
    if (!t) { t = { team: teamId, rounds: [] }; tally.set(teamId.id, t); }
    t.rounds[round] = (t.rounds[round] || 0) + 1;
  }

  for (let iter = 0; iter < iterations; iter++) {
    let currentMatches = matchesNow;
    let round = 0;

    while (currentMatches.length > 0) {
      const winners = simulateRound(currentMatches);

      // Tally: cada ganador llega a la SIGUIENTE ronda (round + 1)
      for (const w of winners) incrTally(w, round + 1);

      // Si solo queda 1 partido = la final → terminamos
      if (currentMatches.length === 1) break;

      // Emparejar para siguiente ronda
      const nextPairs = pairNextRound(winners);
      // Sin predictionsMap para futures matches → defaults
      currentMatches = nextPairs.map(p => ({
        teamA: p.teamA, teamB: p.teamB,
        pAWins: 40, pDraw: 25,  // sin data, prediccion neutra
      }));
      round++;
    }
  }

  // Agregar a porcentajes
  const totalRounds = Math.ceil(Math.log2(initialBracket.length * 2));

  function bucketize(round) {
    const out = {};
    for (const [teamId, t] of tally.entries()) {
      const count = t.rounds[round] || 0;
      const pct = +(count / iterations * 100).toFixed(1);
      if (pct > 0) {
        out[teamId] = {
          team: t.team,
          probability: pct,
        };
      }
    }
    return out;
  }

  // round=totalRounds → campeon. round=totalRounds-1 → finalista. Etc.
  return {
    iterations,
    totalRounds,
    champion:  bucketize(totalRounds),
    finalist:  bucketize(totalRounds - 1),
    semis:     bucketize(totalRounds - 2),
    quarters:  bucketize(totalRounds - 3),
  };
}
