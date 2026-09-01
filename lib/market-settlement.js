// Liquidación visual de mercados a partir de resultados oficiales ya cargados.
//
// Este módulo NO cambia el motor, probabilidades ni cuotas. Solo compara una
// selección existente con el marcador/boxscore disponible. Una pérdida nunca
// se declara antes de que termine el periodo correspondiente y un mercado sin
// cobertura oficial permanece pendiente.

const FOOTBALL_FINAL = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO']);
const BASEBALL_FINAL = new Set(['FT', 'AOT', 'FINAL']);
const MULTISPORT_FINAL = new Set(['FT', 'AOT', 'FINAL']);

const finite = (value) => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const statusShort = (value) => typeof value === 'string' ? value : value?.short;

function normalizeSport(sport) {
  const value = String(sport || '').toLowerCase().replaceAll('_', '-');
  if (value === 'futbol' || value === 'soccer') return 'football';
  if (value === 'beisbol' || value === 'baseball') return 'baseball';
  if (value === 'nfl' || value === 'americanfootball' || value === 'futbol-americano') return 'american-football';
  if (value === 'basket' || value === 'baloncesto') return 'basketball';
  return value;
}

function matchStatus(sport, game, live) {
  if (sport === 'football') {
    const scheduled = statusShort(game?.fixture?.status);
    return FOOTBALL_FINAL.has(scheduled)
      ? scheduled
      : (statusShort(live?.status) || scheduled || '');
  }
  if (sport === 'baseball') {
    const scheduled = statusShort(game?.status);
    return BASEBALL_FINAL.has(scheduled)
      ? scheduled
      : (statusShort(live?.status) || scheduled || '');
  }
  return statusShort(game?.status) || statusShort(live?.status) || '';
}

function isFinalStatus(sport, status) {
  if (sport === 'football') return FOOTBALL_FINAL.has(status);
  if (sport === 'baseball') return BASEBALL_FINAL.has(status);
  return MULTISPORT_FINAL.has(status);
}

function scorePair(sport, game, live) {
  if (sport === 'football') {
    return {
      home: finite(live?.goals?.home ?? game?.goals?.home),
      away: finite(live?.goals?.away ?? game?.goals?.away),
    };
  }
  if (sport === 'baseball') {
    return {
      home: finite(live?.home_score ?? game?.scores?.home?.total),
      away: finite(live?.away_score ?? game?.scores?.away?.total),
    };
  }
  return {
    home: finite(game?.scores?.home?.total ?? live?.scores?.home?.total ?? live?.home_score),
    away: finite(game?.scores?.away?.total ?? live?.scores?.away?.total ?? live?.away_score),
  };
}

function sumKnown(home, away) {
  return home == null || away == null ? null : home + away;
}

function counterPair(counter) {
  if (!counter || counter.isReal === false) return { home: null, away: null, total: null };
  const home = finite(counter.home);
  const away = finite(counter.away);
  const total = finite(counter.total) ?? sumKnown(home, away);
  return { home, away, total };
}

function footballMetric(live, metric) {
  if (metric === 'goals') return null;
  if (metric === 'cards') {
    const direct = counterPair(live?.cards);
    if (direct.total != null) return direct;
    const yellow = counterPair(live?.yellowCards);
    const red = counterPair(live?.redCards);
    if (yellow.home == null || yellow.away == null || red.home == null || red.away == null) {
      return { home: null, away: null, total: null };
    }
    return {
      home: yellow.home + red.home,
      away: yellow.away + red.away,
      total: yellow.home + yellow.away + red.home + red.away,
    };
  }
  const key = metric === 'shots_on' ? 'sot' : metric;
  return counterPair(live?.[key]);
}

function compareLine(value, line, side, complete) {
  const observed = finite(value);
  const threshold = finite(line);
  if (observed == null || threshold == null) return pending();
  if (side === 'over') {
    if (observed > threshold) return won(observed);
    if (!complete) return pending(observed);
    if (observed === threshold) return voided(observed);
    return lost(observed);
  }
  if (side === 'under') {
    // En marcadores/contadores acumulativos, superar la línea ya hace
    // irreversible la derrota aunque el partido siga en vivo.
    if (observed > threshold) return lost(observed);
    if (!complete) return pending(observed);
    if (observed < threshold) return won(observed);
    return voided(observed);
  }
  return pending(observed);
}

function compareWinner(home, away, side, complete) {
  if (!complete || home == null || away == null) return pending();
  const actual = home === away ? 'draw' : home > away ? 'home' : 'away';
  return actual === side ? won(`${home}-${away}`) : lost(`${home}-${away}`);
}

function compareHandicap(home, away, side, line, complete) {
  if (!complete || home == null || away == null || finite(line) == null) return pending();
  const adjusted = side === 'away' ? away + Number(line) - home : home + Number(line) - away;
  if (adjusted > 0) return won(adjusted);
  if (adjusted < 0) return lost(adjusted);
  return voided(adjusted);
}

function pending(observed = null) {
  return { status: 'pending', settled: false, observed };
}

function won(observed = null) {
  return { status: 'won', settled: true, observed };
}

function lost(observed = null) {
  return { status: 'lost', settled: true, observed };
}

function voided(observed = null) {
  return { status: 'void', settled: true, observed };
}

function normalizedName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function samePlayer(event, selection) {
  const wantedId = selection?.playerId == null ? null : String(selection.playerId);
  const eventId = event?.playerId == null ? null : String(event.playerId);
  if (wantedId && eventId) return wantedId === eventId;
  const wanted = normalizedName(selection?.playerName || selection?.name?.split(/[—-]/)[0]);
  const actual = normalizedName(event?.player || event?.name);
  return !!wanted && !!actual && (wanted === actual || wanted.includes(actual) || actual.includes(wanted));
}

function footballHalfScores(game, live, half) {
  const score = live?.score || game?.score || {};
  const halftime = score.halftime || score.halfTime || null;
  const halfHome = finite(halftime?.home);
  const halfAway = finite(halftime?.away);
  if (half === '1h') return { home: halfHome, away: halfAway };
  const full = scorePair('football', game, live);
  return {
    home: full.home == null || halfHome == null ? null : full.home - halfHome,
    away: full.away == null || halfAway == null ? null : full.away - halfAway,
  };
}

function footballPeriodComplete(status, half) {
  if (half === '1h') return ['HT', '2H', 'ET', 'P', 'BT', ...FOOTBALL_FINAL].includes(status);
  return isFinalStatus('football', status);
}

function settleFootball(selection, game, live, status) {
  const id = String(selection?.id || selection?.marketKey || selection?.market || '');
  const final = isFinalStatus('football', status);
  const score = scorePair('football', game, live);
  const totalGoals = sumKnown(score.home, score.away);

  // Catálogo canónico context-engine: total_goals_over2_5,
  // home_corners_under4_5, total_goals_1h_over0_5, etc.
  const contextOu = id.match(/^(total|home|away)_(goals|corners|cards|shots_on|shots|sot|fouls|offsides)(?:_(1h|2h))?_(over|under)(\d+)_5$/);
  if (contextOu) {
    const [, scope, metric, half, side, whole] = contextOu;
    const line = Number(`${whole}.5`);
    const complete = half ? footballPeriodComplete(status, half) : final;
    let pair;
    if (metric === 'goals') pair = half ? footballHalfScores(game, live, half) : score;
    else if (half) pair = live?.periods?.[half]?.[metric] || live?.halves?.[half]?.[metric] || null;
    else pair = footballMetric(live, metric);
    const value = scope === 'total' ? sumKnown(finite(pair?.home), finite(pair?.away)) : finite(pair?.[scope]);
    return compareLine(value, line, side, complete);
  }

  // Catálogo anterior buildCombinada: conserva _line/_side/category.
  const legacyCategory = String(selection?.category || '');
  const legacyOu = legacyCategory.match(/^(total|home|away)-(goals|corners|cards|shots|sot|fouls|offsides)$/);
  if (legacyOu && finite(selection?._line ?? selection?.line) != null) {
    const [, scope, metric] = legacyOu;
    const pair = metric === 'goals' ? score : footballMetric(live, metric);
    const value = scope === 'total' ? sumKnown(finite(pair?.home), finite(pair?.away)) : finite(pair?.[scope]);
    return compareLine(value, selection._line ?? selection.line, selection._side ?? selection.side, final);
  }

  if (['home_win', 'winner-home'].includes(id)) return compareWinner(score.home, score.away, 'home', final);
  if (['draw', 'winner-draw'].includes(id)) return compareWinner(score.home, score.away, 'draw', final);
  if (['away_win', 'winner-away'].includes(id)) return compareWinner(score.home, score.away, 'away', final);
  if (['btts', 'btts-yes'].includes(id)) {
    if (score.home > 0 && score.away > 0) return won(`${score.home}-${score.away}`);
    return final && score.home != null && score.away != null ? lost(`${score.home}-${score.away}`) : pending();
  }
  if (['btts_no', 'btts-no'].includes(id)) {
    if (score.home > 0 && score.away > 0) return lost(`${score.home}-${score.away}`);
    return final && score.home != null && score.away != null
      ? (score.home === 0 || score.away === 0 ? won(`${score.home}-${score.away}`) : lost(`${score.home}-${score.away}`))
      : pending();
  }

  const halfWinner = id.match(/^winner(?:-|_)(1H|2H)(?:-|_)(home|draw|away)$/i);
  if (halfWinner) {
    const half = halfWinner[1].toLowerCase();
    const pair = footballHalfScores(game, live, half);
    return compareWinner(pair.home, pair.away, halfWinner[2].toLowerCase(), footballPeriodComplete(status, half));
  }

  if (id === 'clean_sheet_home' || id === 'clean_sheet_away') {
    const conceded = id.endsWith('home') ? score.away : score.home;
    return final && conceded != null ? (conceded === 0 ? won(conceded) : lost(conceded)) : pending();
  }

  const doubleChance = id.match(/^dc_(1x|12|x2)$/);
  if (doubleChance && final && score.home != null && score.away != null) {
    const actual = score.home === score.away ? 'x' : score.home > score.away ? '1' : '2';
    return doubleChance[1].includes(actual) ? won(actual) : lost(actual);
  }

  if ((id === 'goals_odd' || id === 'goals_even') && final && totalGoals != null) {
    const parity = totalGoals % 2 ? 'odd' : 'even';
    return id.endsWith(parity) ? won(totalGoals) : lost(totalGoals);
  }

  const exactGoals = id.match(/^exact_goals_(\d+|7plus)$/);
  if (exactGoals && final && totalGoals != null) {
    const hit = exactGoals[1] === '7plus' ? totalGoals >= 7 : totalGoals === Number(exactGoals[1]);
    return hit ? won(totalGoals) : lost(totalGoals);
  }

  const correctScore = id.match(/^cs_(\d+)_(\d+)$/);
  if (correctScore && final && score.home != null && score.away != null) {
    return score.home === Number(correctScore[1]) && score.away === Number(correctScore[2])
      ? won(`${score.home}-${score.away}`) : lost(`${score.home}-${score.away}`);
  }

  const redScope = ({ red_card_any: 'total', red_card_home: 'home', red_card_away: 'away',
    'total-red-card': 'total', 'home-red-card': 'home', 'away-red-card': 'away' })[id];
  if (redScope) {
    const reds = counterPair(live?.redCards);
    const value = redScope === 'total' ? reds.total : reds[redScope];
    if (value > 0) return won(value);
    return final && value === 0 ? lost(value) : pending(value);
  }

  const most = id.match(/^most[-_](corners|shots|fouls)(?:[-_](?:full))?[-_](home|draw|away)$/);
  if (most) {
    const pair = footballMetric(live, most[1]);
    return compareWinner(pair?.home, pair?.away, most[2], final);
  }

  if (/^(scorer|assists|booked)-/.test(id)) {
    const family = id.split('-')[0];
    const events = family === 'booked' ? (live?.cardEvents || []) : (live?.goalScorers || []);
    const hit = events.some((event) => family === 'assists'
      ? samePlayer({ player: event.assist, playerId: event.assistId }, selection)
      : samePlayer(event, selection));
    if (hit) return won(1);
    return final ? lost(0) : pending(0);
  }

  return pending();
}

function baseballInningPair(live, start, end) {
  const innings = Array.isArray(live?.innings) ? live.innings : [];
  const selected = innings.filter((inning) => {
    const number = finite(inning?.number ?? inning?.num);
    return number != null && number >= start && number <= end;
  });
  if (!selected.length) return { home: null, away: null };
  const homeValues = selected.map((inning) => finite(inning.home));
  const awayValues = selected.map((inning) => finite(inning.away));
  return {
    home: homeValues.some((value) => value == null) ? null : homeValues.reduce((sum, value) => sum + value, 0),
    away: awayValues.some((value) => value == null) ? null : awayValues.reduce((sum, value) => sum + value, 0),
  };
}

function genericPeriodPair(game, periodKey) {
  const home = Array.isArray(game?.periods?.home) ? game.periods.home.map(finite) : [];
  const away = Array.isArray(game?.periods?.away) ? game.periods.away.map(finite) : [];
  if (!home.length || !away.length) return { home: null, away: null };
  const pick = (indices) => ({
    home: indices.some((index) => home[index] == null) ? null : indices.reduce((sum, index) => sum + home[index], 0),
    away: indices.some((index) => away[index] == null) ? null : indices.reduce((sum, index) => sum + away[index], 0),
  });
  if (periodKey === 'firstHalf' || periodKey === 'halves') return pick([0, 1]);
  if (periodKey === 'secondHalf') return pick([2, 3]);
  const quarter = String(periodKey).match(/^quarter([1-4])$/)?.[1];
  return quarter ? pick([Number(quarter) - 1]) : { home: null, away: null };
}

function genericPeriodComplete(status, periodKey, final) {
  if (final) return true;
  if (periodKey === 'firstHalf' || periodKey === 'halves') return ['HT', 'Q3', 'Q4', 'OT'].includes(status);
  if (periodKey === 'secondHalf') return false;
  const wanted = Number(String(periodKey).match(/^quarter([1-4])$/)?.[1]);
  const current = Number(String(status).match(/^Q([1-4])$/)?.[1]);
  return !!wanted && (!!current && current > wanted || status === 'HT' && wanted <= 2);
}

function baseballPeriod(live, periodKey, final) {
  const inning = finite(live?.inning);
  if (periodKey === 'first5' || periodKey === 'firstFive') {
    return { pair: baseballInningPair(live, 1, 5), complete: final || inning > 5 };
  }
  const exact = String(periodKey).match(/^inning(\d+)$/)?.[1];
  if (exact) {
    const number = Number(exact);
    return { pair: baseballInningPair(live, number, number), complete: final || inning > number };
  }
  return { pair: { home: null, away: null }, complete: final };
}

function baseballStatPair(live, metric) {
  if (metric === 'hits') return { home: finite(live?.home_hits), away: finite(live?.away_hits) };
  if (metric === 'errors') return { home: finite(live?.home_errors), away: finite(live?.away_errors) };
  return { home: finite(live?.home_stats?.[metric]), away: finite(live?.away_stats?.[metric]) };
}

function settleMultisport(sport, selection, game, live, status) {
  const id = String(selection?.id || selection?.marketKey || selection?.market || '');
  const final = isFinalStatus(sport, status);
  const score = scorePair(sport, game, live);
  const total = sumKnown(score.home, score.away);
  const line = finite(selection?.line ?? selection?._line);
  const side = selection?.side || (id.endsWith('-over') ? 'over' : id.endsWith('-under') ? 'under' : null);

  if (id === 'ml-home') return compareWinner(score.home, score.away, 'home', final);
  if (id === 'ml-away') return compareWinner(score.home, score.away, 'away', final);
  if (id === 'ml-draw') return compareWinner(score.home, score.away, 'draw', final);

  if (/^total-/.test(id) && line != null) return compareLine(total, line, side, final);

  if (/^handicap-(home|away)-/.test(id)) {
    const selectedSide = id.match(/^handicap-(home|away)-/)?.[1] || side;
    return compareHandicap(score.home, score.away, selectedSide, line, final);
  }

  const teamTotal = id.match(/^team-total-(home|away)-/);
  if (teamTotal && line != null) return compareLine(score[teamTotal[1]], line, side, final);

  const periodMoneyline = id.match(/^(.+)-moneyline-(home|away|draw)$/);
  const periodHandicap = id.match(/^(.+)-handicap-(home|away)-/);
  const periodTeamTotal = id.match(/^(.+)-team-total-(home|away)-/);
  const periodTotal = !/^team-total-/.test(id) && id.match(/^(.+)-total-[^-]+-(over|under)$/);
  const periodRun = id.match(/^(.+)-run-(yes|no)$/);
  const periodKey = periodMoneyline?.[1] || periodHandicap?.[1] || periodTeamTotal?.[1] || periodTotal?.[1] || periodRun?.[1];
  if (periodKey) {
    const period = sport === 'baseball'
      ? baseballPeriod(live, periodKey, final)
      : { pair: genericPeriodPair(game, periodKey), complete: genericPeriodComplete(status, periodKey, final) };
    const periodTotalValue = sumKnown(period.pair.home, period.pair.away);
    if (periodMoneyline) return compareWinner(period.pair.home, period.pair.away, periodMoneyline[2], period.complete);
    if (periodHandicap) return compareHandicap(period.pair.home, period.pair.away, periodHandicap[2], line, period.complete);
    if (periodTeamTotal) return compareLine(period.pair[periodTeamTotal[2]], line, side, period.complete);
    if (periodTotal) return compareLine(periodTotalValue, line, side, period.complete);
    if (periodRun) {
      if (periodTotalValue > 0) return periodRun[2] === 'yes' ? won(periodTotalValue) : lost(periodTotalValue);
      return period.complete ? (periodRun[2] === 'no' ? won(0) : lost(0)) : pending(0);
    }
  }

  const stat = id.match(/^stat-([a-zA-Z]+)-(total|home|away)-/);
  if (sport === 'baseball' && stat && line != null) {
    const pair = baseballStatPair(live, stat[1]);
    const value = stat[2] === 'total' ? sumKnown(pair.home, pair.away) : pair[stat[2]];
    return compareLine(value, line, side, final);
  }

  if (sport === 'baseball' && /^special-total-parity-(odd|even)$/.test(id) && final && total != null) {
    const wanted = id.endsWith('odd') ? 'odd' : 'even';
    return (total % 2 ? 'odd' : 'even') === wanted ? won(total) : lost(total);
  }
  const teamParity = sport === 'baseball' && id.match(/^special-team-parity-(home|away)-(odd|even)$/);
  if (teamParity && final && score[teamParity[1]] != null) {
    const actual = score[teamParity[1]] % 2 ? 'odd' : 'even';
    return actual === teamParity[2] ? won(score[teamParity[1]]) : lost(score[teamParity[1]]);
  }
  const highest = sport === 'baseball' && id.match(/^special-highest-(home|away|draw)$/);
  if (highest) return compareWinner(score.home, score.away, highest[1], final);
  const extra = sport === 'baseball' && id.match(/^special-extra-innings-(yes|no)$/);
  if (extra && final) {
    const hadExtras = finite(live?.inning) > 9 || (Array.isArray(live?.innings) && live.innings.some((inning) => finite(inning?.number) > 9));
    return (extra[1] === 'yes') === hadExtras ? won(hadExtras ? 1 : 0) : lost(hadExtras ? 1 : 0);
  }
  const exact = sport === 'baseball' && id.match(/^special-correct-score-(\d+)-(\d+)$/);
  if (exact && final && score.home != null && score.away != null) {
    return score.home === Number(exact[1]) && score.away === Number(exact[2])
      ? won(`${score.home}-${score.away}`) : lost(`${score.home}-${score.away}`);
  }

  return pending();
}

export function settleMarketSelection({ sport, selection, game, liveResult } = {}) {
  const normalizedSport = normalizeSport(sport);
  const live = liveResult || game?.liveResult || null;
  const status = matchStatus(normalizedSport, game, live);
  if (normalizedSport === 'football') return settleFootball(selection, game, live, status);
  if (['baseball', 'basketball', 'american-football'].includes(normalizedSport)) {
    return settleMultisport(normalizedSport, selection, game, live, status);
  }
  return pending();
}

export function marketResultState({ sport, game, liveResult } = {}) {
  const normalizedSport = normalizeSport(sport);
  const status = matchStatus(normalizedSport, game, liveResult || game?.liveResult);
  return {
    status,
    isFinal: isFinalStatus(normalizedSport, status),
    isLive: !!status && !isFinalStatus(normalizedSport, status)
      && !['NS', 'TBD', 'POST', 'PST', 'CANC', 'SUSP', 'ABD'].includes(status),
  };
}

export const settlementInternals = {
  compareLine,
  compareWinner,
  compareHandicap,
  footballHalfScores,
  baseballInningPair,
  genericPeriodPair,
};
