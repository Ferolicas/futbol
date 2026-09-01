// "Veredicto final" es un cálculo aislado. No alimenta ni modifica el motor
// comercial existente: selecciona una muestra oficial acotada, vuelve a contar
// frecuencias y solo publica mercados que existen exactamente en Bet365.

import { computeMultisportEmpiricalPrediction } from './multisport-empirical-engine.js';
import { getMultisportConfig } from './multisport-config.js';

export const FINAL_VERDICT_VERSION = 1;
export const FINAL_VERDICT_MIN_ODD = 1.5;

const FORBIDDEN_GAME_RE = /\b(friendly|friendlies|amistoso|preseason|pre-season|exhibition|spring training|warm[ -]?up)\b/i;

const normalizeBookmaker = (value) => String(value || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

const numberOrNull = (value) => {
  const parsed = Number(value);
  return value == null || value === '' || !Number.isFinite(parsed) ? null : parsed;
};

const average = (values) => {
  const usable = values.map(numberOrNull).filter((value) => value != null);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
};

const rounded = (value) => value == null ? null : Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function rate(values, predicate) {
  const usable = values.map(numberOrNull).filter((value) => value != null);
  if (!usable.length) return null;
  const hits = usable.filter(predicate).length;
  const rawProbability = hits / usable.length;
  return {
    probability: rawProbability >= .95 ? 95 : Math.floor((rawProbability * 100 + 1e-9) * 100) / 100,
    rawProbability,
    evidence: { n: usable.length, hits },
  };
}

function participantProjection(primaryRows, primaryKey, opponentRows, opponentKey) {
  const left = primaryRows.map((row) => row[primaryKey]);
  const right = opponentRows.map((row) => row[opponentKey]);
  return {
    expected: rounded(average([average(left), average(right)].filter((value) => value != null))),
    probability(line, predicate = (value) => value > line) {
      const rates = [rate(left, predicate), rate(right, predicate)].filter(Boolean);
      if (!rates.length) return null;
      const rawProbability = rates.reduce((sum, item) => sum + item.rawProbability, 0) / rates.length;
      return {
        probability: rawProbability >= .95 ? 95 : Math.floor((rawProbability * 100 + 1e-9) * 100) / 100,
        rawProbability,
        evidence: {
          n: rates.reduce((sum, item) => sum + item.evidence.n, 0),
          hits: rates.reduce((sum, item) => sum + item.evidence.hits, 0),
          participants: rates.length,
        },
      };
    },
  };
}

function dedupeByFixture(rows) {
  const output = new Map();
  for (const row of rows || []) output.set(String(row.fixture_id), row);
  return [...output.values()];
}

function newestFirst(left, right) {
  return new Date(right.kickoff).getTime() - new Date(left.kickoff).getTime();
}

/**
 * Prioridad contractual H2H: misma competición primero. Solo se completan los
 * huecos (hasta dos) con otras competiciones oficiales, siempre por fecha.
 */
export function selectCompetitionAwareH2H(rows, competitionId, limit = 2) {
  const unique = dedupeByFixture(rows).sort(newestFirst);
  const exact = unique.filter((row) => String(row.competition_id) === String(competitionId));
  const fallback = unique.filter((row) => String(row.competition_id) !== String(competitionId));
  return [...exact.slice(0, limit), ...fallback.slice(0, Math.max(0, limit - exact.length))]
    .slice(0, limit);
}

function firstAndLastFive(rows) {
  const ordered = dedupeByFixture(rows).sort((left, right) => new Date(left.kickoff) - new Date(right.kickoff));
  return dedupeByFixture([...ordered.slice(0, 5), ...ordered.slice(-5)]).sort(newestFirst);
}

export function selectVerdictTeamHistory(rows, { competitionId, season }) {
  const official = (rows || []).filter((row) => row._official !== false);
  const current = official.filter((row) => String(row.competition_id) === String(competitionId)
    && String(row.season) === String(season)).sort(newestFirst);
  if (current.length) return { rows: current, source: 'current-season', season: String(season) };

  const sameCompetition = official.filter((row) => String(row.competition_id) === String(competitionId)
    && String(row.season) !== String(season)).sort(newestFirst);
  const previousSeason = sameCompetition[0]?.season;
  if (previousSeason == null) return { rows: [], source: 'no-history', season: null };
  return {
    rows: firstAndLastFive(sameCompetition.filter((row) => String(row.season) === String(previousSeason))),
    source: 'previous-season-first-last-5',
    season: String(previousSeason),
  };
}

export function isOfficialMultisportRow(row, sport) {
  const raw = row?.match_raw || row?.raw || {};
  const text = JSON.stringify(raw);
  if (FORBIDDEN_GAME_RE.test(text)) return false;
  const seasonType = Number(raw?.season?.type ?? raw?.seasonType ?? raw?.type?.id);
  if (seasonType === 1 && (sport === 'basketball' || sport === 'american_football')) return false;
  if (sport === 'baseball') {
    const gameType = String(raw?.gameType ?? raw?.game_type ?? '').toUpperCase();
    if (['S', 'E', 'A'].includes(gameType)) return false;
  }
  return true;
}

function probabilityPercent(entry) {
  const raw = numberOrNull(entry?.rawProbability);
  if (raw != null) return raw <= 1 ? raw * 100 : raw;
  return numberOrNull(entry?.probability ?? entry);
}

function bet365Odd(entry) {
  const odd = numberOrNull(typeof entry === 'object' ? entry?.odd : entry);
  const bookmaker = typeof entry === 'object' ? entry?.bookmaker : null;
  return odd != null && odd >= FINAL_VERDICT_MIN_ODD && normalizeBookmaker(bookmaker) === 'bet365'
    ? { odd, bookmaker: 'Bet365' }
    : null;
}

/** Una sola opción por familia: mayor probabilidad y, en empate, mayor cuota. */
export function selectHighestVerdictPicks(candidates) {
  const byFamily = new Map();
  for (const candidate of candidates || []) {
    const previous = byFamily.get(candidate.family);
    if (!previous || candidate.rawProbability > previous.rawProbability
      || (candidate.rawProbability === previous.rawProbability && candidate.odd > previous.odd)) {
      byFamily.set(candidate.family, candidate);
    }
  }
  return [...byFamily.values()].sort((left, right) => right.rawProbability - left.rawProbability || right.odd - left.odd);
}

function verdictCandidateCollector() {
  const candidates = [];
  return {
    add({ family, market, name, probability, odd, line = null, side = null, period = null }) {
      const price = bet365Odd(odd);
      const rawProbability = probabilityPercent(probability);
      if (!price || rawProbability == null) return;
      candidates.push({
        id: `${family}-${String(line ?? side ?? candidates.length).replace(/[^a-z0-9]+/gi, '-')}`,
        family, market, name, probability: rawProbability >= 95 ? 95 : rounded(rawProbability),
        rawProbability, ...price, line, side, period,
        sampleN: probability?.evidence?.n ?? null,
        sampleHits: probability?.evidence?.hits ?? null,
      });
    },
    result: () => selectHighestVerdictPicks(candidates),
  };
}

function addOverLadder(collector, { family, market, label, probabilities, odds, period = null }) {
  for (const [line, price] of Object.entries(odds || {})) {
    const overOdd = price?.over;
    if (!overOdd) continue;
    collector.add({
      family, market, name: `Más de ${line} ${label}`,
      probability: probabilities?.[line]?.over, odd: overOdd,
      line: Number(line), side: 'over', period,
    });
  }
}

function h2hEvidence(rows, competitionId) {
  return rows.map((row) => ({
    fixtureId: String(row.fixture_id),
    date: row.kickoff,
    competitionId: String(row.competition_id),
    competition: row.competition_name || null,
    sameCompetition: String(row.competition_id) === String(competitionId),
    homeTeam: row.home_team || null,
    awayTeam: row.away_team || null,
    homeScore: numberOrNull(row.home_score ?? (row.is_home ? row.score_for : row.score_against)),
    awayScore: numberOrNull(row.away_score ?? (row.is_home ? row.score_against : row.score_for)),
  }));
}

async function loadMultisportVerdictRows(pool, sport, fixture) {
  const config = getMultisportConfig(sport);
  const statsTable = `${config.tablePrefix}_engine_team_stats`;
  const matchesTable = `${config.tablePrefix}_engine_matches`;
  const teamIds = [String(fixture.teams.home.id), String(fixture.teams.away.id)];
  const { rows } = await pool.query(
    `SELECT s.*,m.raw AS match_raw,m.status AS match_status,
            m.home_team,m.away_team,m.home_score,m.away_score
       FROM ${statsTable} s
       JOIN ${matchesTable} m ON m.fixture_id=s.fixture_id
      WHERE s.team_id=ANY($1::text[]) AND s.kickoff<$2
      ORDER BY s.kickoff DESC`,
    [teamIds, fixture.date],
  );
  const official = rows.filter((row) => isOfficialMultisportRow(row, config.key))
    .map((row) => ({ ...row, _official: true }));
  const homeHistory = official.filter((row) => String(row.team_id) === teamIds[0]);
  const awayHistory = official.filter((row) => String(row.team_id) === teamIds[1]);
  const homeSelection = selectVerdictTeamHistory(homeHistory, {
    competitionId: fixture.league?.id, season: fixture.season,
  });
  const awaySelection = selectVerdictTeamHistory(awayHistory, {
    competitionId: fixture.league?.id, season: fixture.season,
  });
  const h2h = selectCompetitionAwareH2H(
    homeHistory.filter((row) => String(row.opponent_id) === teamIds[1]),
    fixture.league?.id,
  );
  const h2hIds = new Set(h2h.map((row) => String(row.fixture_id)));
  return {
    homeRows: dedupeByFixture([...homeSelection.rows, ...homeHistory.filter((row) => h2hIds.has(String(row.fixture_id)))]),
    awayRows: dedupeByFixture([...awaySelection.rows, ...awayHistory.filter((row) => h2hIds.has(String(row.fixture_id)))]),
    homeSelection,
    awaySelection,
    h2h,
  };
}

export async function buildMultisportFinalVerdict(pool, { sport, fixture, odds }) {
  const config = getMultisportConfig(sport);
  const sample = await loadMultisportVerdictRows(pool, config.key, fixture);
  const prediction = await computeMultisportEmpiricalPrediction(pool, {
    sport: config.key,
    fixture,
    odds,
    teamRows: { home: sample.homeRows, away: sample.awayRows },
    config: { venueBoost: 1, opponentBoost: 1, competitionBoost: 1, starterBoost: 1, lineupBoost: 1 },
  });
  const picks = verdictCandidateCollector();
  picks.add({ family: 'match-winner', market: 'Ganador del partido', name: `${fixture.teams.home.name} gana`, probability: prediction.moneyline?.home, odd: odds?.moneyline?.home, side: 'home' });
  picks.add({ family: 'match-winner', market: 'Ganador del partido', name: `${fixture.teams.away.name} gana`, probability: prediction.moneyline?.away, odd: odds?.moneyline?.away, side: 'away' });
  picks.add({ family: 'match-winner', market: 'Ganador del partido', name: 'Empate', probability: prediction.moneyline?.draw, odd: odds?.moneyline?.draw, side: 'draw' });
  addOverLadder(picks, { family: 'match-total', market: `Total de ${config.scoreLabel}`, label: config.scoreLabel, probabilities: prediction.totals?.lines, odds: odds?.totals });

  for (const side of ['home', 'away']) {
    for (const [line, odd] of Object.entries(odds?.spreads?.[side] || {})) picks.add({
      family: 'match-spread', market: 'Hándicap del partido',
      name: `${fixture.teams[side].name} ${Number(line) > 0 ? '+' : ''}${line}`,
      probability: prediction.spreads?.[side]?.[line], odd,
      line: Number(line), side,
    });
  }

  for (const side of ['home', 'away']) {
    addOverLadder(picks, {
      family: `team-total-${side}`, market: `Total de ${fixture.teams[side].name}`,
      label: `${config.scoreLabel} de ${fixture.teams[side].name}`,
      probabilities: prediction.teamTotals?.[side], odds: odds?.teamTotals?.[side],
    });
  }
  for (const [periodKey, periodOdds] of Object.entries(odds?.periods || {})) {
    const period = prediction.periods?.[periodKey];
    if (!period) continue;
    const label = periodOdds.label || period.label || periodKey;
    picks.add({ family: `${periodKey}-winner`, market: `Ganador (${label})`, name: `${fixture.teams.home.name} gana en ${label}`, probability: period.moneyline?.home, odd: periodOdds.moneyline?.home, side: 'home', period: periodKey });
    picks.add({ family: `${periodKey}-winner`, market: `Ganador (${label})`, name: `${fixture.teams.away.name} gana en ${label}`, probability: period.moneyline?.away, odd: periodOdds.moneyline?.away, side: 'away', period: periodKey });
    picks.add({ family: `${periodKey}-winner`, market: `Ganador (${label})`, name: `Empate en ${label}`, probability: period.moneyline?.draw, odd: periodOdds.moneyline?.draw, side: 'draw', period: periodKey });
    addOverLadder(picks, { family: `${periodKey}-total`, market: `Total (${label})`, label: `${config.scoreLabel} en ${label}`, probabilities: period.totals, odds: periodOdds.totals, period: periodKey });
    for (const side of ['home', 'away']) {
      for (const [line, odd] of Object.entries(periodOdds.spreads?.[side] || {})) picks.add({
        family: `${periodKey}-spread`, market: `Hándicap (${label})`,
        name: `${fixture.teams[side].name} ${Number(line) > 0 ? '+' : ''}${line} en ${label}`,
        probability: period.spreads?.[side]?.[line], odd,
        line: Number(line), side, period: periodKey,
      });
    }
    for (const side of ['home', 'away']) addOverLadder(picks, {
      family: `${periodKey}-team-${side}`, market: `${fixture.teams[side].name} (${label})`,
      label: `${config.scoreLabel} de ${fixture.teams[side].name} en ${label}`,
      probabilities: period.teamTotals?.[side], odds: periodOdds.teamTotals?.[side], period: periodKey,
    });
    for (const [metric, scopes] of Object.entries(period.statistics || {})) {
      for (const scope of ['home', 'away', 'total']) {
        const name = scope === 'total' ? 'ambos equipos' : fixture.teams[scope].name;
        addOverLadder(picks, {
          family: `${periodKey}-stat-${metric}-${scope}`,
          market: `${scopes.label || metric} de ${name} (${label})`,
          label: `${scopes.label || metric} de ${name} en ${label}`,
          probabilities: scopes[scope], odds: periodOdds.statistics?.[metric]?.[scope], period: periodKey,
        });
      }
    }
  }
  for (const [metric, scopes] of Object.entries(prediction.statistics || {})) {
    for (const scope of ['home', 'away', 'total']) {
      const name = scope === 'total' ? 'ambos equipos' : fixture.teams[scope].name;
      addOverLadder(picks, {
        family: `stat-${metric}-${scope}`, market: `${scopes.label || metric} de ${name}`,
        label: `${scopes.label || metric} de ${name}`, probabilities: scopes[scope],
        odds: odds?.statistics?.[metric]?.[scope],
      });
    }
  }

  return {
    version: FINAL_VERDICT_VERSION,
    status: sample.homeRows.length && sample.awayRows.length ? 'ready' : 'insufficient-history',
    sport: config.key,
    rules: { officialOnly: true, currentCompetitionFirst: true, h2hLimit: 2, overOnly: true, bookmaker: 'Bet365', minOdd: FINAL_VERDICT_MIN_ODD },
    samples: {
      home: { count: sample.homeRows.length, source: sample.homeSelection.source, season: sample.homeSelection.season },
      away: { count: sample.awayRows.length, source: sample.awaySelection.source, season: sample.awaySelection.season },
    },
    h2h: h2hEvidence(sample.h2h, fixture.league?.id),
    expected: {
      match: prediction.expected,
      periods: Object.fromEntries(Object.entries(prediction.periods || {}).map(([key, value]) => [key, value.expected])),
      statistics: Object.fromEntries(Object.entries(prediction.statistics || {}).map(([key, value]) => [key, {
        label: value.label,
        home: value.expected?.home ?? null,
        away: value.expected?.away ?? null,
        total: value.expected?.total ?? null,
      }])),
    },
    picks: picks.result(),
    calculatedAt: new Date().toISOString(),
  };
}

function isOfficialFootballRow(row) {
  const category = String(row.competition_category || row.competition_category_model || '').toLowerCase();
  const name = String(row.competition_name || '');
  return category !== 'friendly_intl' && !FORBIDDEN_GAME_RE.test(`${category} ${name}`);
}

async function enrichFootballEvents(pool, rows) {
  const fixtureIds = [...new Set(rows.map((row) => Number(row.fixture_id)).filter(Number.isFinite))];
  if (!fixtureIds.length) return rows;
  const { rows: events } = await pool.query(
    `SELECT fixture_id,team_id,count(*)::int AS event_rows,
            count(*) FILTER (WHERE lower(type)='card' AND COALESCE(minute,0)<=45)::int AS cards_1h,
            count(*) FILTER (WHERE lower(type)='card' AND COALESCE(minute,0)>45)::int AS cards_2h,
            bool_or(lower(COALESCE(detail,'') || ' ' || COALESCE(comments,'') || ' ' || COALESCE(type,'')) LIKE '%penalty%') AS had_penalty
       FROM model.match_events WHERE fixture_id=ANY($1::bigint[])
      GROUP BY fixture_id,team_id`,
    [fixtureIds],
  );
  const byTeam = new Map(events.map((event) => [`${event.fixture_id}:${event.team_id}`, event]));
  const fixturesWithEvents = new Set(events.map((event) => String(event.fixture_id)));
  const penaltyByFixture = new Map();
  for (const event of events) if (event.had_penalty) penaltyByFixture.set(String(event.fixture_id), true);
  return rows.map((row) => {
    const covered = fixturesWithEvents.has(String(row.fixture_id));
    const own = byTeam.get(`${row.fixture_id}:${row.team_id}`);
    const opponent = byTeam.get(`${row.fixture_id}:${row.opponent_id}`);
    return {
      ...row,
      cards_1h_for: covered ? Number(own?.cards_1h || 0) : null,
      cards_2h_for: covered ? Number(own?.cards_2h || 0) : null,
      cards_1h_against: covered ? Number(opponent?.cards_1h || 0) : null,
      cards_2h_against: covered ? Number(opponent?.cards_2h || 0) : null,
      had_penalty: covered ? penaltyByFixture.has(String(row.fixture_id)) : null,
    };
  });
}

async function loadFootballVerdictRows(pool, fixture) {
  const teamIds = [Number(fixture.teams.home.id), Number(fixture.teams.away.id)];
  const { rows } = await pool.query(
    `SELECT s.*,c.name AS competition_name,c.category AS competition_category_model,
            m.home_team_id,m.away_team_id,m.ft_home AS home_score,m.ft_away AS away_score,
            ht.name AS home_team,at.name AS away_team
       FROM model.team_match_stats s
       JOIN model.matches m ON m.fixture_id=s.fixture_id
       LEFT JOIN model.competitions c ON c.competition_id=s.competition_id
       LEFT JOIN model.teams ht ON ht.team_id=m.home_team_id
       LEFT JOIN model.teams at ON at.team_id=m.away_team_id
      WHERE s.team_id=ANY($1::bigint[]) AND s.kickoff<$2
      ORDER BY s.kickoff DESC`,
    [teamIds, fixture.date],
  );
  const official = rows.filter(isOfficialFootballRow).map((row) => ({ ...row, _official: true }));
  const homeHistory = official.filter((row) => Number(row.team_id) === teamIds[0]);
  const awayHistory = official.filter((row) => Number(row.team_id) === teamIds[1]);
  const selectionArgs = { competitionId: fixture.league.id, season: fixture.league.season };
  const homeSelection = selectVerdictTeamHistory(homeHistory, selectionArgs);
  const awaySelection = selectVerdictTeamHistory(awayHistory, selectionArgs);
  const h2h = selectCompetitionAwareH2H(homeHistory.filter((row) => Number(row.opponent_id) === teamIds[1]), fixture.league.id);
  const h2hIds = new Set(h2h.map((row) => String(row.fixture_id)));
  const selected = await enrichFootballEvents(pool, dedupeByFixture([
    ...homeSelection.rows, ...awaySelection.rows,
    ...homeHistory.filter((row) => h2hIds.has(String(row.fixture_id))),
    ...awayHistory.filter((row) => h2hIds.has(String(row.fixture_id))),
  ]));
  return {
    homeRows: selected.filter((row) => Number(row.team_id) === teamIds[0]),
    awayRows: selected.filter((row) => Number(row.team_id) === teamIds[1]),
    homeSelection, awaySelection,
    h2h: h2h.map((item) => selected.find((row) => String(row.fixture_id) === String(item.fixture_id)
      && Number(row.team_id) === teamIds[0]) || item),
  };
}

function totalProjection(rows, ownKey, againstKey) {
  const byFixture = new Map();
  for (const row of rows) {
    const own = numberOrNull(row[ownKey]);
    const against = numberOrNull(row[againstKey]);
    if (own != null && against != null) byFixture.set(String(row.fixture_id), own + against);
  }
  const values = [...byFixture.values()];
  return { expected: rounded(average(values)), probability: (line, predicate = (value) => value > line) => rate(values, predicate) };
}

function outcomeProjection(homeRows, homeFor, homeAgainst, awayRows, awayFor, awayAgainst) {
  const homeMargins = homeRows.map((row) => {
    const a = numberOrNull(row[homeFor]), b = numberOrNull(row[homeAgainst]);
    return a == null || b == null ? null : a - b;
  });
  const opponentMargins = awayRows.map((row) => {
    const a = numberOrNull(row[awayFor]), b = numberOrNull(row[awayAgainst]);
    return a == null || b == null ? null : b - a;
  });
  const values = [...homeMargins, ...opponentMargins].filter((value) => value != null);
  return {
    home: rate(values, (value) => value > 0),
    draw: rate(values, (value) => value === 0),
    away: rate(values, (value) => value < 0),
  };
}

function footballProjections(homeRows, awayRows) {
  const period = (suffix, keys) => {
    const home = participantProjection(homeRows, keys.for, awayRows, keys.against);
    const away = participantProjection(awayRows, keys.for, homeRows, keys.against);
    const total = totalProjection([...homeRows, ...awayRows], keys.for, keys.against);
    return { suffix, home, away, total };
  };
  const periods = {
    full: {
      goals: period('full', { for: 'goals_for', against: 'goals_against' }),
      cards: period('full', { for: 'cards_for', against: 'cards_against' }),
      corners: period('full', { for: 'corners_for', against: 'corners_against' }),
      shots: period('full', { for: 'shots_for', against: 'shots_against' }),
      sot: period('full', { for: 'sot_for', against: 'sot_against' }),
    },
    firstHalf: {
      goals: period('firstHalf', { for: 'gf_1h', against: 'ga_1h' }),
      cards: period('firstHalf', { for: 'cards_1h_for', against: 'cards_1h_against' }),
      corners: period('firstHalf', { for: 'corners_1h', against: 'corners_1h_against' }),
      shots: period('firstHalf', { for: 'shots_1h', against: 'shots_1h_against' }),
      sot: period('firstHalf', { for: 'sot_1h', against: 'sot_1h_against' }),
    },
    secondHalf: {
      goals: period('secondHalf', { for: 'gf_2h', against: 'ga_2h' }),
      cards: period('secondHalf', { for: 'cards_2h_for', against: 'cards_2h_against' }),
      corners: period('secondHalf', { for: 'corners_2h', against: 'corners_2h_against' }),
      shots: period('secondHalf', { for: 'shots_2h', against: 'shots_2h_against' }),
      sot: period('secondHalf', { for: 'sot_2h', against: 'sot_2h_against' }),
    },
  };
  // Las columnas de mitad solo guardan "a favor". La perspectiva contraria se
  // obtiene de la fila gemela del rival cuando existe.
  const opponentRows = new Map([...homeRows, ...awayRows].map((row) => [`${row.fixture_id}:${row.team_id}`, row]));
  for (const row of [...homeRows, ...awayRows]) {
    const opponent = opponentRows.get(`${row.fixture_id}:${row.opponent_id}`);
    row.corners_1h_against = opponent?.corners_1h ?? null;
    row.corners_2h_against = opponent?.corners_2h ?? null;
    row.shots_1h_against = opponent?.shots_1h ?? null;
    row.shots_2h_against = opponent?.shots_2h ?? null;
    row.sot_1h_against = opponent?.sot_1h ?? null;
    row.sot_2h_against = opponent?.sot_2h ?? null;
    row.cards_for = numberOrNull(row.yellow_for) == null && numberOrNull(row.red_for) == null ? null : Number(row.yellow_for || 0) + Number(row.red_for || 0);
    row.cards_against = numberOrNull(row.yellow_against) == null && numberOrNull(row.red_against) == null ? null : Number(row.yellow_against || 0) + Number(row.red_against || 0);
  }
  // Recalcular después de completar las columnas derivadas.
  return footballProjectionsReady(homeRows, awayRows, periods);
}

function footballProjectionsReady(homeRows, awayRows, periods) {
  const rebuild = (periodKey, metric, forKey, againstKey) => {
    const home = participantProjection(homeRows, forKey, awayRows, againstKey);
    const away = participantProjection(awayRows, forKey, homeRows, againstKey);
    periods[periodKey][metric] = { home, away, total: totalProjection([...homeRows, ...awayRows], forKey, againstKey) };
  };
  rebuild('full', 'cards', 'cards_for', 'cards_against');
  for (const [periodKey, suffix] of [['firstHalf', '1h'], ['secondHalf', '2h']]) {
    rebuild(periodKey, 'corners', `corners_${suffix}`, `corners_${suffix}_against`);
    rebuild(periodKey, 'shots', `shots_${suffix}`, `shots_${suffix}_against`);
    rebuild(periodKey, 'sot', `sot_${suffix}`, `sot_${suffix}_against`);
  }
  return {
    periods,
    winners: {
      full: outcomeProjection(homeRows, 'goals_for', 'goals_against', awayRows, 'goals_for', 'goals_against'),
      firstHalf: outcomeProjection(homeRows, 'gf_1h', 'ga_1h', awayRows, 'gf_1h', 'ga_1h'),
      secondHalf: outcomeProjection(homeRows, 'gf_2h', 'ga_2h', awayRows, 'gf_2h', 'ga_2h'),
    },
    mostShots: {
      full: outcomeProjection(homeRows, 'shots_for', 'shots_against', awayRows, 'shots_for', 'shots_against'),
      firstHalf: outcomeProjection(homeRows, 'shots_1h', 'shots_1h_against', awayRows, 'shots_1h', 'shots_1h_against'),
      secondHalf: outcomeProjection(homeRows, 'shots_2h', 'shots_2h_against', awayRows, 'shots_2h', 'shots_2h_against'),
    },
    mostSot: {
      full: outcomeProjection(homeRows, 'sot_for', 'sot_against', awayRows, 'sot_for', 'sot_against'),
      firstHalf: outcomeProjection(homeRows, 'sot_1h', 'sot_1h_against', awayRows, 'sot_1h', 'sot_1h_against'),
      secondHalf: outcomeProjection(homeRows, 'sot_2h', 'sot_2h_against', awayRows, 'sot_2h', 'sot_2h_against'),
    },
    redCard: (() => {
      const values = dedupeByFixture([...homeRows, ...awayRows]).map((row) => Number(row.red_for || 0) + Number(row.red_against || 0));
      const yes = rate(values, (value) => value > 0); return { yes, no: yes && { ...yes, probability: rounded(100 - yes.probability), rawProbability: 1 - yes.rawProbability, evidence: { n: yes.evidence.n, hits: yes.evidence.n - yes.evidence.hits } } };
    })(),
    penalty: (() => {
      const values = dedupeByFixture([...homeRows, ...awayRows]).map((row) => row.had_penalty == null ? null : Number(row.had_penalty));
      const yes = rate(values, (value) => value > 0); return { yes, no: yes && { ...yes, probability: rounded(100 - yes.probability), rawProbability: 1 - yes.rawProbability, evidence: { n: yes.evidence.n, hits: yes.evidence.n - yes.evidence.hits } } };
    })(),
  };
}

function parseOverLine(key) {
  const match = String(key).match(/^Over[_\s-]?(\d+)(?:[_\.]?(\d+))?$/i);
  if (!match) return null;
  return Number(`${match[1]}.${match[2] || '0'}`);
}

function addFootballOvers(collector, odds, projection, family, market, label, period = null) {
  for (const [key, odd] of Object.entries(odds || {})) {
    const line = parseOverLine(key);
    if (line == null) continue;
    collector.add({ family, market, name: `Más de ${line} ${label}`, probability: projection?.probability(line), odd: { odd, bookmaker: 'Bet365' }, line, side: 'over', period });
  }
}

function addFootballChoice(collector, odds, probabilities, family, market, names, period = null) {
  for (const side of ['home', 'draw', 'away']) collector.add({
    family, market, name: names[side], probability: probabilities?.[side],
    odd: odds?.[side] == null ? null : { odd: odds[side], bookmaker: 'Bet365' }, side, period,
  });
}

function addFootballExtraYesNo(collector, extraMarkets, probabilities, type, label) {
  const matcher = type === 'red' ? /red card|tarjeta roja/i : /penalt|penalty/i;
  for (const [market, values] of Object.entries(extraMarkets || {})) {
    if (!matcher.test(market)) continue;
    for (const entry of values || []) {
      const normalized = String(entry.value || '').toLowerCase();
      const side = /^(yes|sí|si)$/.test(normalized) ? 'yes' : (/^no$/.test(normalized) ? 'no' : null);
      if (!side) continue;
      collector.add({ family: type, market: label, name: `${label}: ${side === 'yes' ? 'Sí' : 'No'}`, probability: probabilities?.[side], odd: { odd: entry.odd, bookmaker: 'Bet365' }, side });
    }
  }
}

export async function buildFootballFinalVerdict(pool, { fixture, odds }) {
  const sample = await loadFootballVerdictRows(pool, fixture);
  const projections = footballProjections(sample.homeRows, sample.awayRows);
  const bookmakerOdds = (odds?.allBookmakerOdds || []).find((bookmaker) => normalizeBookmaker(bookmaker.name) === 'bet365')
    || (normalizeBookmaker(odds?.bookmaker) === 'bet365' ? odds : null);
  const picks = verdictCandidateCollector();
  const homeName = fixture.teams.home.name;
  const awayName = fixture.teams.away.name;
  if (bookmakerOdds) {
    addFootballOvers(picks, bookmakerOdds.overUnder, projections.periods.full.goals.total, 'goals-full-total', 'Goles del partido', 'goles');
    addFootballOvers(picks, bookmakerOdds.homeGoals, projections.periods.full.goals.home, 'goals-full-home', `Goles de ${homeName}`, `goles de ${homeName}`);
    addFootballOvers(picks, bookmakerOdds.awayGoals, projections.periods.full.goals.away, 'goals-full-away', `Goles de ${awayName}`, `goles de ${awayName}`);
    addFootballOvers(picks, bookmakerOdds.goals1H, projections.periods.firstHalf.goals.total, 'goals-1h-total', 'Goles 1.ª parte', 'goles en la 1.ª parte', 'firstHalf');
    addFootballOvers(picks, bookmakerOdds.goals2H, projections.periods.secondHalf.goals.total, 'goals-2h-total', 'Goles 2.ª parte', 'goles en la 2.ª parte', 'secondHalf');
    addFootballOvers(picks, bookmakerOdds.homeGoals1H, projections.periods.firstHalf.goals.home, 'goals-1h-home', `${homeName} 1.ª parte`, `goles de ${homeName} en la 1.ª parte`, 'firstHalf');
    addFootballOvers(picks, bookmakerOdds.awayGoals1H, projections.periods.firstHalf.goals.away, 'goals-1h-away', `${awayName} 1.ª parte`, `goles de ${awayName} en la 1.ª parte`, 'firstHalf');
    addFootballOvers(picks, bookmakerOdds.homeGoals2H, projections.periods.secondHalf.goals.home, 'goals-2h-home', `${homeName} 2.ª parte`, `goles de ${homeName} en la 2.ª parte`, 'secondHalf');
    addFootballOvers(picks, bookmakerOdds.awayGoals2H, projections.periods.secondHalf.goals.away, 'goals-2h-away', `${awayName} 2.ª parte`, `goles de ${awayName} en la 2.ª parte`, 'secondHalf');

    for (const [metric, label, totalKey, homeKey, awayKey] of [
      ['corners', 'córners', 'corners', 'homeCorners', 'awayCorners'],
      ['cards', 'tarjetas', 'cards', 'homeCards', 'awayCards'],
      ['shots', 'remates', 'shots', 'homeShots', 'awayShots'],
      ['sot', 'remates a puerta', 'sot', 'homeSot', 'awaySot'],
    ]) {
      addFootballOvers(picks, bookmakerOdds[totalKey], projections.periods.full[metric].total, `${metric}-full-total`, `${label} del partido`, label);
      addFootballOvers(picks, bookmakerOdds[homeKey], projections.periods.full[metric].home, `${metric}-full-home`, `${label} de ${homeName}`, `${label} de ${homeName}`);
      addFootballOvers(picks, bookmakerOdds[awayKey], projections.periods.full[metric].away, `${metric}-full-away`, `${label} de ${awayName}`, `${label} de ${awayName}`);
    }
    addFootballOvers(picks, bookmakerOdds.corners1H, projections.periods.firstHalf.corners.total, 'corners-1h-total', 'Córners 1.ª parte', 'córners en la 1.ª parte', 'firstHalf');
    addFootballOvers(picks, bookmakerOdds.corners2H, projections.periods.secondHalf.corners.total, 'corners-2h-total', 'Córners 2.ª parte', 'córners en la 2.ª parte', 'secondHalf');
    addFootballOvers(picks, bookmakerOdds.cards1H, projections.periods.firstHalf.cards.total, 'cards-1h-total', 'Tarjetas 1.ª parte', 'tarjetas en la 1.ª parte', 'firstHalf');
    addFootballOvers(picks, bookmakerOdds.cards2H, projections.periods.secondHalf.cards.total, 'cards-2h-total', 'Tarjetas 2.ª parte', 'tarjetas en la 2.ª parte', 'secondHalf');
    addFootballOvers(picks, bookmakerOdds.shots1H, projections.periods.firstHalf.shots.total, 'shots-1h-total', 'Remates 1.ª parte', 'remates en la 1.ª parte', 'firstHalf');
    addFootballOvers(picks, bookmakerOdds.shots2H, projections.periods.secondHalf.shots.total, 'shots-2h-total', 'Remates 2.ª parte', 'remates en la 2.ª parte', 'secondHalf');
    addFootballOvers(picks, bookmakerOdds.sot1H, projections.periods.firstHalf.sot.total, 'sot-1h-total', 'Remates a puerta 1.ª parte', 'remates a puerta en la 1.ª parte', 'firstHalf');
    addFootballOvers(picks, bookmakerOdds.sot2H, projections.periods.secondHalf.sot.total, 'sot-2h-total', 'Remates a puerta 2.ª parte', 'remates a puerta en la 2.ª parte', 'secondHalf');

    addFootballChoice(picks, bookmakerOdds.matchWinner, projections.winners.full, 'winner-full', 'Ganador del partido', { home: `${homeName} gana`, draw: 'Empate', away: `${awayName} gana` });
    addFootballChoice(picks, bookmakerOdds.winner1H, projections.winners.firstHalf, 'winner-1h', 'Ganador 1.ª parte', { home: `${homeName} gana la 1.ª parte`, draw: 'Empate en la 1.ª parte', away: `${awayName} gana la 1.ª parte` }, 'firstHalf');
    addFootballChoice(picks, bookmakerOdds.winner2H, projections.winners.secondHalf, 'winner-2h', 'Ganador 2.ª parte', { home: `${homeName} gana la 2.ª parte`, draw: 'Empate en la 2.ª parte', away: `${awayName} gana la 2.ª parte` }, 'secondHalf');
    addFootballChoice(picks, bookmakerOdds.shots1x2, projections.mostShots.full, 'most-shots-full', 'Equipo con más remates', { home: `${homeName} hace más remates`, draw: 'Mismos remates', away: `${awayName} hace más remates` });
    addFootballChoice(picks, bookmakerOdds.shots1x21H, projections.mostShots.firstHalf, 'most-shots-1h', 'Más remates 1.ª parte', { home: `${homeName} hace más remates en la 1.ª parte`, draw: 'Mismos remates en la 1.ª parte', away: `${awayName} hace más remates en la 1.ª parte` }, 'firstHalf');
    addFootballChoice(picks, bookmakerOdds.shots1x22H, projections.mostShots.secondHalf, 'most-shots-2h', 'Más remates 2.ª parte', { home: `${homeName} hace más remates en la 2.ª parte`, draw: 'Mismos remates en la 2.ª parte', away: `${awayName} hace más remates en la 2.ª parte` }, 'secondHalf');
    addFootballChoice(picks, bookmakerOdds.sot1x2, projections.mostSot.full, 'most-sot-full', 'Más remates a puerta', { home: `${homeName} hace más remates a puerta`, draw: 'Mismos remates a puerta', away: `${awayName} hace más remates a puerta` });
    addFootballChoice(picks, bookmakerOdds.sot1x21H, projections.mostSot.firstHalf, 'most-sot-1h', 'Más remates a puerta 1.ª parte', { home: `${homeName} hace más remates a puerta en la 1.ª parte`, draw: 'Mismos remates a puerta en la 1.ª parte', away: `${awayName} hace más remates a puerta en la 1.ª parte` }, 'firstHalf');
    addFootballChoice(picks, bookmakerOdds.sot1x22H, projections.mostSot.secondHalf, 'most-sot-2h', 'Más remates a puerta 2.ª parte', { home: `${homeName} hace más remates a puerta en la 2.ª parte`, draw: 'Mismos remates a puerta en la 2.ª parte', away: `${awayName} hace más remates a puerta en la 2.ª parte` }, 'secondHalf');
    addFootballChoice(picks, bookmakerOdds.corners1x2, outcomeProjection(sample.homeRows, 'corners_for', 'corners_against', sample.awayRows, 'corners_for', 'corners_against'), 'most-corners-full', 'Equipo con más córners', { home: `${homeName} hace más córners`, draw: 'Mismos córners', away: `${awayName} hace más córners` });
    addFootballExtraYesNo(picks, bookmakerOdds.extraMarkets, projections.redCard, 'red', 'Tarjeta roja');
    addFootballExtraYesNo(picks, bookmakerOdds.extraMarkets, projections.penalty, 'penalty', 'Penalti');
  }

  const expected = Object.fromEntries(Object.entries(projections.periods).map(([period, metrics]) => [period,
    Object.fromEntries(Object.entries(metrics).map(([metric, values]) => [metric, {
      home: values.home.expected, away: values.away.expected, total: values.total.expected,
    }]))]));
  return {
    version: FINAL_VERDICT_VERSION,
    status: sample.homeRows.length && sample.awayRows.length ? 'ready' : 'insufficient-history',
    sport: 'football',
    rules: { officialOnly: true, currentCompetitionFirst: true, h2hLimit: 2, overOnly: true, bookmaker: 'Bet365', minOdd: FINAL_VERDICT_MIN_ODD },
    samples: {
      home: { count: sample.homeRows.length, source: sample.homeSelection.source, season: sample.homeSelection.season },
      away: { count: sample.awayRows.length, source: sample.awaySelection.source, season: sample.awaySelection.season },
    },
    h2h: h2hEvidence(sample.h2h, fixture.league.id),
    expected,
    picks: picks.result(),
    calculatedAt: new Date().toISOString(),
  };
}
