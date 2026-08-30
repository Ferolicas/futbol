import { pgPool } from './db.js';

const REPORT_TIME_ZONE = 'America/Bogota';
const HISTORY_START = '2026-01-01T05:00:00.000Z';
const NON_PLAYABLE_STATUSES = new Set(['PST', 'CANC', 'ABD', 'AWD', 'WO', 'SUSP']);
const FRIENDLY_COMPETITION_IDS = new Set([10, 667]);

function officialCompetitionSql(alias = 'c') {
  return `${alias}.competition_id NOT IN (10,667)
          AND COALESCE(${alias}.category,'') <> 'friendly_intl'
          AND COALESCE(LOWER(${alias}.name),'') NOT LIKE '%friendly%'
          AND COALESCE(LOWER(${alias}.name),'') NOT LIKE '%amistos%'`;
}

export function isOfficialFootballCompetition(competition) {
  const competitionId = Number(competition?.competition_id ?? competition?.competitionId);
  const category = String(competition?.category || '').trim().toLowerCase();
  const name = String(competition?.competition_name || competition?.name || '').trim().toLowerCase();
  return Number.isSafeInteger(competitionId)
    && competitionId > 0
    && !FRIENDLY_COMPETITION_IDS.has(competitionId)
    && category !== 'friendly_intl'
    && !name.includes('friendly')
    && !name.includes('amistos');
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, decimals = 2) {
  const number = numberOrNull(value);
  if (number == null) return null;
  const factor = 10 ** decimals;
  return Math.round((number + Number.EPSILON) * factor) / factor;
}

function dateInBogota(value) {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function timeInBogota(value) {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: REPORT_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function dateWindow(date) {
  const start = new Date(`${date}T05:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

export function buildTeamFirstHalfCornerProfile(rows, cutoff) {
  const cutoffMs = new Date(cutoff || '').getTime();
  const eligible = (Array.isArray(rows) ? rows : [])
    .filter((row) => {
      const kickoffMs = new Date(row.kickoff || '').getTime();
      return Number.isFinite(kickoffMs)
        && (!Number.isFinite(cutoffMs) || kickoffMs < cutoffMs)
        && numberOrNull(row.corners_1h) != null;
    })
    .sort((a, b) => new Date(b.kickoff).getTime() - new Date(a.kickoff).getTime());

  const total = eligible.reduce((sum, row) => sum + Number(row.corners_1h), 0);
  return {
    sample: eligible.length,
    average: eligible.length ? round(total / eligible.length) : null,
    recent: eligible.slice(0, 5).map((row) => ({
      fixtureId: Number(row.fixture_id) || null,
      date: dateInBogota(row.kickoff),
      kickoff: row.kickoff,
      opponent: row.opponent_name || 'Rival',
      league: row.competition_name || 'Competición',
      isHome: row.is_home === true,
      corners: Number(row.corners_1h),
    })),
  };
}

export function expectedFirstHalfCorners(homeProfile, awayProfile) {
  const home = numberOrNull(homeProfile?.average);
  const away = numberOrNull(awayProfile?.average);
  return home == null || away == null ? null : round(home + away, 1);
}

export function assembleFootballFirstHalfCornerMatches(fixtures, statsByTeam) {
  return (Array.isArray(fixtures) ? fixtures : []).map((fixture) => {
    const homeTeamId = Number(fixture.home_team_id);
    const awayTeamId = Number(fixture.away_team_id);
    const home = buildTeamFirstHalfCornerProfile(statsByTeam.get(homeTeamId) || [], fixture.kickoff);
    const away = buildTeamFirstHalfCornerProfile(statsByTeam.get(awayTeamId) || [], fixture.kickoff);
    return {
      fixtureId: Number(fixture.fixture_id) || null,
      kickoff: fixture.kickoff,
      time: timeInBogota(fixture.kickoff),
      league: fixture.competition_name || 'Competición',
      status: fixture.status || null,
      home: { teamId: homeTeamId, name: fixture.home_team_name || 'Local', ...home },
      away: { teamId: awayTeamId, name: fixture.away_team_name || 'Visitante', ...away },
      expectedCorners: expectedFirstHalfCorners(home, away),
    };
  });
}

function csvCell(value) {
  if (value == null || value === '') return '—';
  const text = String(value);
  return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function decimal(value) {
  const number = numberOrNull(value);
  return number == null ? '—' : number.toFixed(2).replace('.', ',');
}

function recentSummary(team) {
  return (team?.recent || [])
    .map((match) => `${match.date} · ${match.opponent}: ${match.corners}`)
    .join(' | ') || 'Sin datos';
}

export function renderFootballFirstHalfCornersCsv(matches) {
  const header = [
    'Hora COL',
    'Liga',
    'Partido',
    'Córners esperados 1.ª parte',
    'Promedio local 2026',
    'Muestra local',
    'Promedio visitante 2026',
    'Muestra visitante',
    'Últimos 5 local',
    'Últimos 5 visitante',
  ];
  const body = (matches || []).map((match) => [
    match.time,
    match.league,
    `${match.home.name} vs ${match.away.name}`,
    decimal(match.expectedCorners),
    decimal(match.home.average),
    match.home.sample,
    decimal(match.away.average),
    match.away.sample,
    recentSummary(match.home),
    recentSummary(match.away),
  ].map(csvCell).join(';'));
  return `\uFEFF${[header.join(';'), ...body].join('\n')}\n`;
}

async function loadTeamDirectory() {
  const { rows } = await pgPool.query(
    `SELECT t.team_id,t.name,t.country,
            COUNT(*)::int AS matches_2026,
            COUNT(s.corners_1h)::int AS covered_matches,
            AVG(s.corners_1h)::float8 AS average_1h
       FROM model.team_match_stats s
       JOIN model.teams t ON t.team_id=s.team_id
       JOIN model.competitions c ON c.competition_id=s.competition_id
      WHERE s.kickoff >= $1::timestamptz
        AND ${officialCompetitionSql('c')}
      GROUP BY t.team_id,t.name,t.country
      ORDER BY t.name,t.country,t.team_id`,
    [HISTORY_START],
  );
  return rows.map((row) => ({
    teamId: Number(row.team_id),
    name: row.name || `Equipo ${row.team_id}`,
    country: row.country || '',
    matches: Number(row.matches_2026) || 0,
    coveredMatches: Number(row.covered_matches) || 0,
    average: round(row.average_1h),
  }));
}

async function loadSelectedTeamHistory(teamId) {
  if (!Number.isSafeInteger(teamId) || teamId < 1) return null;
  const { rows } = await pgPool.query(
    `SELECT s.fixture_id,s.team_id,s.kickoff,s.is_home,s.corners_1h,
            own.name AS team_name,opp.name AS opponent_name,
            COALESCE(c.name,'Competición') AS competition_name
       FROM model.team_match_stats s
       JOIN model.teams own ON own.team_id=s.team_id
       LEFT JOIN model.teams opp ON opp.team_id=s.opponent_id
       JOIN model.competitions c ON c.competition_id=s.competition_id
      WHERE s.team_id=$1 AND s.kickoff >= $2::timestamptz
        AND ${officialCompetitionSql('c')}
      ORDER BY s.kickoff DESC,s.fixture_id DESC`,
    [teamId, HISTORY_START],
  );
  if (!rows.length) return null;
  const covered = rows.filter((row) => numberOrNull(row.corners_1h) != null);
  const total = covered.reduce((sum, row) => sum + Number(row.corners_1h), 0);
  return {
    teamId,
    name: rows[0].team_name || `Equipo ${teamId}`,
    matches: rows.length,
    coveredMatches: covered.length,
    average: covered.length ? round(total / covered.length) : null,
    history: rows.map((row) => ({
      fixtureId: Number(row.fixture_id) || null,
      date: dateInBogota(row.kickoff),
      kickoff: row.kickoff,
      opponent: row.opponent_name || 'Rival',
      league: row.competition_name || 'Competición',
      isHome: row.is_home === true,
      corners: numberOrNull(row.corners_1h),
    })),
  };
}

export async function buildFootballFirstHalfCornersReport(date, options = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error('Fecha inválida para el informe de córners');
  }
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const selectedTeamId = Number(options.selectedTeamId);
  const { start, end } = dateWindow(date);
  const today = dateInBogota(nowMs);

  const { rows: fixtureRows } = await pgPool.query(
    `SELECT m.fixture_id,m.competition_id,m.kickoff,m.status,m.home_team_id,m.away_team_id,
            home.name AS home_team_name,away.name AS away_team_name,
            COALESCE(c.name,'Competición') AS competition_name,c.category
       FROM model.matches m
       JOIN model.teams home ON home.team_id=m.home_team_id
       JOIN model.teams away ON away.team_id=m.away_team_id
       JOIN model.competitions c ON c.competition_id=m.competition_id
      WHERE m.kickoff >= $1::timestamptz AND m.kickoff < $2::timestamptz
        AND ${officialCompetitionSql('c')}
      ORDER BY m.kickoff,m.fixture_id`,
    [start.toISOString(), end.toISOString()],
  );

  const fixtures = fixtureRows.filter((fixture) => {
    if (!isOfficialFootballCompetition(fixture)) return false;
    if (NON_PLAYABLE_STATUSES.has(String(fixture.status || '').toUpperCase())) return false;
    if (date === today) return new Date(fixture.kickoff).getTime() > nowMs;
    return true;
  });
  const teamIds = [...new Set(fixtures.flatMap((fixture) => [
    Number(fixture.home_team_id),
    Number(fixture.away_team_id),
  ]).filter(Number.isSafeInteger))];
  const statsByTeam = new Map(teamIds.map((teamId) => [teamId, []]));
  if (teamIds.length) {
    const latestKickoff = fixtures.reduce((latest, fixture) => (
      new Date(fixture.kickoff) > latest ? new Date(fixture.kickoff) : latest
    ), start);
    const { rows: statRows } = await pgPool.query(
      `SELECT s.fixture_id,s.team_id,s.kickoff,s.is_home,s.corners_1h,
              opp.name AS opponent_name,COALESCE(c.name,'Competición') AS competition_name
         FROM model.team_match_stats s
         LEFT JOIN model.teams opp ON opp.team_id=s.opponent_id
         JOIN model.competitions c ON c.competition_id=s.competition_id
        WHERE s.team_id=ANY($1::bigint[])
          AND s.kickoff >= $2::timestamptz
          AND s.kickoff < $3::timestamptz
          AND ${officialCompetitionSql('c')}
        ORDER BY s.team_id,s.kickoff DESC`,
      [teamIds, HISTORY_START, latestKickoff.toISOString()],
    );
    for (const row of statRows) {
      const teamId = Number(row.team_id);
      if (statsByTeam.has(teamId)) statsByTeam.get(teamId).push(row);
    }
  }

  const [teams, selectedTeam] = await Promise.all([
    loadTeamDirectory(),
    loadSelectedTeamHistory(selectedTeamId),
  ]);
  const matches = assembleFootballFirstHalfCornerMatches(fixtures, statsByTeam);
  return {
    date,
    sport: 'futbol',
    fixtures: matches.length,
    rows: matches.length,
    remainingOnly: date === today,
    teams,
    selectedTeam,
    coveredTeams: teams.filter((team) => team.coveredMatches > 0).length,
    coveredMatches: teams.reduce((total, team) => total + team.coveredMatches, 0),
    matches,
    filename: `CF_corners_primera_parte_${date}.csv`,
    content: renderFootballFirstHalfCornersCsv(matches),
  };
}
