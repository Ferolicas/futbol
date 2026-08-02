/* eslint-disable */
// Fuente única para convertir un resultado durable de API-Football en el
// snapshot que consumen las tarjetas y el análisis completo.
//
// Regla fundamental: un campo ausente permanece null/omitido. Solo usamos 0
// cuando el proveedor entregó el bloque estadístico del equipo y omitió un
// contador de baja frecuencia (tarjetas), o cuando los eventos oficiales
// demuestran que no hubo uno de esos eventos. Goles y marcador son independientes
// de la cobertura de statistics y siempre se conservan cuando existen.

const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']);

const ALIASES = {
  corners: ['Corner Kicks', 'Corners', 'Corner'],
  yellow: ['Yellow Cards', 'Yellowcards'],
  red: ['Red Cards', 'Redcards'],
};

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '' || value === 'null') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function statusShort(status) {
  return typeof status === 'string' ? status : status?.short;
}

function normalizeStatus(status) {
  if (!status || typeof status !== 'string') return status || null;
  return {
    short: status,
    long: FINISHED_STATUSES.has(status) ? 'Match Finished' : status,
    elapsed: FINISHED_STATUSES.has(status) ? 90 : null,
  };
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function teamStats(match, teamId) {
  return (Array.isArray(match?.statistics) ? match.statistics : [])
    .find((entry) => Number(entry?.team?.id) === Number(teamId)) || null;
}

function hasStatsBlock(block) {
  return !!(block && Array.isArray(block.statistics) && block.statistics.length > 0);
}

function statValue(block, aliases) {
  if (!hasStatsBlock(block)) return null;
  const wanted = new Set((aliases || []).map(normalizeName));
  const found = block.statistics.find((entry) => wanted.has(normalizeName(entry?.type)));
  return finiteOrNull(found?.value);
}

function sumKnown(a, b) {
  return a == null || b == null ? null : a + b;
}

function eventMinute(event) {
  const elapsed = finiteOrNull(event?.time?.elapsed);
  if (elapsed == null) return null;
  return elapsed + (finiteOrNull(event?.time?.extra) || 0);
}

function normalizeGoalEvent(event) {
  if (!event) return null;
  const playerName = event.player?.name ?? event.player ?? event.name ?? null;
  const teamId = event.team?.id ?? event.teamId ?? event.team_id ?? null;
  const minute = eventMinute(event) ?? finiteOrNull(event.minute);
  return {
    player: playerName,
    playerId: event.player?.id ?? event.playerId ?? event.player_id ?? null,
    assist: event.assist?.name ?? event.assist ?? null,
    assistId: event.assist?.id ?? event.assistId ?? null,
    teamId,
    minute,
    extra: event.time?.extra ?? event.extra ?? null,
    type: event.detail ?? event.type ?? null,
  };
}

function normalizeCardEvent(event) {
  if (!event) return null;
  return {
    player: event.player?.name ?? event.player ?? event.name ?? null,
    playerId: event.player?.id ?? event.playerId ?? event.player_id ?? null,
    teamId: event.team?.id ?? event.teamId ?? event.team_id ?? null,
    minute: eventMinute(event) ?? finiteOrNull(event.minute),
    extra: event.time?.extra ?? event.extra ?? null,
    type: event.detail ?? event.type ?? null,
  };
}

function cardEventIs(event, kind) {
  const detail = normalizeName(event?.detail ?? event?.type);
  if (kind === 'yellow') return detail === 'yellow card';
  return detail === 'red card' || detail === 'second yellow card';
}

function extractResultCoverage(match = {}) {
  const homeId = match?.teams?.home?.id ?? null;
  const awayId = match?.teams?.away?.id ?? null;
  const homeStats = teamStats(match, homeId);
  const awayStats = teamStats(match, awayId);
  const events = Array.isArray(match?.events) ? match.events : [];
  const goalEventsRaw = events.filter((event) => event?.type === 'Goal' && event?.detail !== 'Missed Penalty');
  const missedRaw = events.filter((event) => event?.type === 'Goal' && event?.detail === 'Missed Penalty');
  const cardEventsRaw = events.filter((event) => event?.type === 'Card');

  const homeCorners = statValue(homeStats, ALIASES.corners);
  const awayCorners = statValue(awayStats, ALIASES.corners);
  const corners = {
    home: homeCorners,
    away: awayCorners,
    total: sumKnown(homeCorners, awayCorners),
  };

  const cardCounter = (block, teamId, kind) => {
    const aliases = kind === 'yellow' ? ALIASES.yellow : ALIASES.red;
    const fromStats = statValue(block, aliases);
    if (fromStats != null) return fromStats;
    // API-Football omite a menudo "Red Cards"/"Yellow Cards" cuando el
    // bloque del equipo sí existe y el evento no ocurrió: ahí cero es real.
    if (hasStatsBlock(block)) return 0;
    // Sin bloque estadístico solo consideramos completo el contador de eventos
    // si el proveedor entregó al menos una tarjeta en el partido.
    if (cardEventsRaw.length > 0) {
      return cardEventsRaw.filter((event) =>
        Number(event?.team?.id) === Number(teamId) && cardEventIs(event, kind)).length;
    }
    return null;
  };

  const yellowHome = cardCounter(homeStats, homeId, 'yellow');
  const yellowAway = cardCounter(awayStats, awayId, 'yellow');
  const redHome = cardCounter(homeStats, homeId, 'red');
  const redAway = cardCounter(awayStats, awayId, 'red');
  const yellowCards = {
    home: yellowHome,
    away: yellowAway,
    total: sumKnown(yellowHome, yellowAway),
  };
  const redCards = {
    home: redHome,
    away: redAway,
    total: sumKnown(redHome, redAway),
  };
  const cardsHome = sumKnown(yellowHome, redHome);
  const cardsAway = sumKnown(yellowAway, redAway);

  return {
    homeId,
    awayId,
    corners,
    yellowCards,
    redCards,
    cards: { home: cardsHome, away: cardsAway, total: sumKnown(cardsHome, cardsAway) },
    goalScorers: goalEventsRaw.map(normalizeGoalEvent).filter(Boolean),
    cardEvents: cardEventsRaw.map(normalizeCardEvent).filter(Boolean),
    missedPenalties: missedRaw.map(normalizeGoalEvent).filter(Boolean),
  };
}

function buildMatchResultRow(date, match) {
  const coverage = extractResultCoverage(match);
  return {
    fixture_id: Number(match?.fixture?.id),
    date,
    league_id: Number(match?.league?.id),
    league_name: match?.league?.name || null,
    home_team: {
      id: coverage.homeId,
      name: match?.teams?.home?.name || null,
      logo: match?.teams?.home?.logo || null,
    },
    away_team: {
      id: coverage.awayId,
      name: match?.teams?.away?.name || null,
      logo: match?.teams?.away?.logo || null,
    },
    goals: match?.goals || null,
    score: match?.score || null,
    status: match?.fixture?.status || null,
    corners: coverage.corners,
    yellow_cards: coverage.yellowCards,
    red_cards: coverage.redCards,
    goal_scorers: coverage.goalScorers,
    card_events: coverage.cardEvents,
    full_data: match,
  };
}

function completePair(value) {
  return value && finiteOrNull(value.home) != null && finiteOrNull(value.away) != null;
}

function fallbackEvents(rows, mapper) {
  return (Array.isArray(rows) ? rows : []).map(mapper).filter(Boolean);
}

function buildDurableResultSnapshot(row) {
  if (!row) return null;
  const match = row.full_data && typeof row.full_data === 'object' ? row.full_data : null;
  const status = normalizeStatus(row.status || match?.fixture?.status || null);
  if (!FINISHED_STATUSES.has(statusShort(status))) return null;

  const coverage = match ? extractResultCoverage(match) : null;
  const corners = coverage?.corners || row.corners || null;
  const yellowCards = coverage?.yellowCards || row.yellow_cards || null;
  const redCards = coverage?.redCards || row.red_cards || null;
  const goalScorers = coverage
    ? coverage.goalScorers
    : fallbackEvents(row.goal_scorers, normalizeGoalEvent);
  const cardEvents = coverage
    ? coverage.cardEvents
    : fallbackEvents(row.card_events, normalizeCardEvent);
  const missedPenalties = coverage?.missedPenalties || [];

  const snapshot = {
    fixtureId: Number(row.fixture_id ?? match?.fixture?.id),
    status,
    goals: row.goals || match?.goals || null,
    score: row.score || match?.score || null,
    goalScorers,
    cardEvents,
    missedPenalties,
    updatedAt: row.created_at || row.updated_at || new Date().toISOString(),
    savedAt: row.created_at || row.updated_at || new Date().toISOString(),
    realFinal: true,
  };
  // El frontend solo pinta un total si ambos lados están cubiertos. Los valores
  // parciales siguen guardados en match_results/model, pero no se presenta una
  // suma incompleta como si fuera el total del partido.
  if (completePair(corners)) {
    snapshot.corners = {
      home: finiteOrNull(corners.home),
      away: finiteOrNull(corners.away),
      total: finiteOrNull(corners.home) + finiteOrNull(corners.away),
      isReal: true,
    };
  }
  if (completePair(yellowCards)) {
    snapshot.yellowCards = {
      home: finiteOrNull(yellowCards.home),
      away: finiteOrNull(yellowCards.away),
      total: finiteOrNull(yellowCards.home) + finiteOrNull(yellowCards.away),
      isReal: true,
    };
  }
  if (completePair(redCards)) {
    snapshot.redCards = {
      home: finiteOrNull(redCards.home),
      away: finiteOrNull(redCards.away),
      total: finiteOrNull(redCards.home) + finiteOrNull(redCards.away),
      isReal: true,
    };
  }
  return snapshot;
}

function meaningfulCounter(counter) {
  return counter && (counter.isReal === true || Number(counter.total || 0) > 0);
}

function mergeDurableResultWithLive(result, live) {
  if (!result) return live || null;
  if (!live) return result;
  return {
    ...live,
    ...result,
    corners: result.corners || (meaningfulCounter(live.corners) ? live.corners : undefined),
    yellowCards: result.yellowCards || (meaningfulCounter(live.yellowCards) ? live.yellowCards : undefined),
    redCards: result.redCards || (meaningfulCounter(live.redCards) ? live.redCards : undefined),
    goalScorers: result.goalScorers?.length ? result.goalScorers : (live.goalScorers || []),
    cardEvents: result.cardEvents?.length ? result.cardEvents : (live.cardEvents || []),
    missedPenalties: result.missedPenalties?.length ? result.missedPenalties : (live.missedPenalties || []),
    status: result.status,
    goals: result.goals || live.goals,
    score: result.score || live.score,
    realFinal: true,
  };
}

function mergeFixtureWithDurableResult(fixture, snapshot) {
  if (!fixture || !snapshot || !FINISHED_STATUSES.has(statusShort(snapshot.status))) return fixture;
  return {
    ...fixture,
    fixture: { ...fixture.fixture, status: snapshot.status },
    goals: snapshot.goals || fixture.goals,
    score: snapshot.score || fixture.score,
  };
}

module.exports = {
  FINISHED_STATUSES,
  extractResultCoverage,
  buildMatchResultRow,
  buildDurableResultSnapshot,
  mergeDurableResultWithLive,
  mergeFixtureWithDurableResult,
};
