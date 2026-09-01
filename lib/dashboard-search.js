const SPORT_CONFIG = Object.freeze({
  football: {
    label: 'Fútbol',
    href: (id) => `/dashboard/analisis/${encodeURIComponent(id)}`,
  },
  baseball: {
    label: 'Béisbol',
    tablePrefix: 'baseball',
    href: (id) => `/dashboard/baseball/analisis/${encodeURIComponent(id)}`,
  },
  basketball: {
    label: 'Baloncesto',
    tablePrefix: 'basketball',
    href: (id) => `/dashboard/baloncesto/analisis/${encodeURIComponent(id)}`,
  },
  american_football: {
    label: 'Fútbol americano',
    tablePrefix: 'american_football',
    href: (id) => `/dashboard/futbol-americano/analisis/${encodeURIComponent(id)}`,
  },
});

export const DASHBOARD_SEARCH_SPORTS = Object.freeze(Object.keys(SPORT_CONFIG));

export function normalizeDashboardSearchQuery(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s.'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .toLowerCase();
}

export function parseDashboardSearchSports(value) {
  const requested = String(value || '')
    .split(',')
    .map((sport) => sport.trim())
    .filter(Boolean);
  if (!requested.length) return [...DASHBOARD_SEARCH_SPORTS];
  return [...new Set(requested.filter((sport) => DASHBOARD_SEARCH_SPORTS.includes(sport)))];
}

export function dashboardSearchHref(sport, id) {
  return SPORT_CONFIG[sport]?.href(String(id)) || null;
}

const ASCII_SQL = (column) => `translate(lower(COALESCE(${column},'')),'áéíóúüñ','aeiouun')`;

async function searchFootball(pool, pattern, exactQuery, limit) {
  const home = "fixture->'teams'->'home'->>'name'";
  const away = "fixture->'teams'->'away'->>'name'";
  const league = "fixture->'league'->>'name'";
  const result = await pool.query(
    `WITH games AS (
       SELECT
         fixture->'fixture'->>'id' AS id,
         fixture->'fixture'->>'date' AS kickoff,
         fixture->'fixture'->'status'->>'short' AS status,
         fixture->'fixture'->'status'->>'long' AS status_label,
         ${home} AS home_team,
         ${away} AS away_team,
         ${league} AS league,
         NULLIF(fixture->'goals'->>'home','')::numeric AS home_score,
         NULLIF(fixture->'goals'->>'away','')::numeric AS away_score
       FROM fixtures_cache cache
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(cache.fixtures)='array' THEN cache.fixtures ELSE '[]'::jsonb END
       ) AS fixture
       WHERE cache.date BETWEEN CURRENT_DATE - 365 AND CURRENT_DATE + 240
     )
     SELECT * FROM games
     WHERE ${ASCII_SQL('home_team')} LIKE $1
        OR ${ASCII_SQL('away_team')} LIKE $1
        OR ${ASCII_SQL('league')} LIKE $1
     ORDER BY
       CASE WHEN ${ASCII_SQL('home_team')}=$2 OR ${ASCII_SQL('away_team')}=$2 THEN 0 ELSE 1 END,
       ABS(EXTRACT(EPOCH FROM (kickoff::timestamptz - now())))
     LIMIT $3`,
    [pattern, exactQuery, limit],
  );
  return result.rows.map((row) => ({ ...row, sport: 'football' }));
}

async function searchEngineSport(pool, sport, pattern, exactQuery, limit) {
  const { tablePrefix } = SPORT_CONFIG[sport];
  const matchesTable = `${tablePrefix}_engine_matches`;
  const analysisTable = `${tablePrefix}_match_analysis`;
  const home = 'matches.home_team';
  const away = 'matches.away_team';
  const league = "COALESCE(analysis.league_name,matches.raw#>>'{league,name}',matches.competition_id)";
  const result = await pool.query(
    `SELECT
       matches.fixture_id AS id,
       matches.kickoff,
       matches.status,
       matches.home_team,
       matches.away_team,
       ${league} AS league,
       matches.home_score,
       matches.away_score
     FROM ${matchesTable} matches
     LEFT JOIN ${analysisTable} analysis ON analysis.fixture_id::text=matches.fixture_id
     WHERE matches.kickoff BETWEEN now() - interval '18 months' AND now() + interval '8 months'
       AND (
         ${ASCII_SQL(home)} LIKE $1
         OR ${ASCII_SQL(away)} LIKE $1
         OR ${ASCII_SQL(league)} LIKE $1
       )
     ORDER BY
       CASE WHEN ${ASCII_SQL(home)}=$2 OR ${ASCII_SQL(away)}=$2 THEN 0 ELSE 1 END,
       ABS(EXTRACT(EPOCH FROM (matches.kickoff - now())))
     LIMIT $3`,
    [pattern, exactQuery, limit],
  );
  return result.rows.map((row) => ({ ...row, sport }));
}

function serializeResult(row) {
  const id = String(row.id);
  return {
    id,
    sport: row.sport,
    sportLabel: SPORT_CONFIG[row.sport]?.label || row.sport,
    homeTeam: row.home_team || 'Local',
    awayTeam: row.away_team || 'Visitante',
    league: row.league || null,
    kickoff: row.kickoff instanceof Date ? row.kickoff.toISOString() : row.kickoff,
    status: row.status || null,
    statusLabel: row.status_label || null,
    homeScore: row.home_score == null ? null : Number(row.home_score),
    awayScore: row.away_score == null ? null : Number(row.away_score),
    href: dashboardSearchHref(row.sport, id),
  };
}

export async function searchDashboardMatches(pool, { query, sports, limit = 28 }) {
  const normalizedQuery = normalizeDashboardSearchQuery(query);
  if (normalizedQuery.length < 2) return [];
  const selectedSports = parseDashboardSearchSports(sports);
  if (!selectedSports.length) return [];
  const perSportLimit = Math.max(5, Math.min(14, Math.ceil(limit / selectedSports.length) + 2));
  const pattern = `%${normalizedQuery}%`;

  const batches = await Promise.all(selectedSports.map(async (sport) => {
    try {
      return sport === 'football'
        ? await searchFootball(pool, pattern, normalizedQuery, perSportLimit)
        : await searchEngineSport(pool, sport, pattern, normalizedQuery, perSportLimit);
    } catch (error) {
      console.error(`[dashboard-search:${sport}]`, error.message);
      return [];
    }
  }));

  const now = Date.now();
  return batches.flat()
    .map(serializeResult)
    .filter((result) => result.href)
    .sort((left, right) => {
      const leftTime = new Date(left.kickoff).getTime();
      const rightTime = new Date(right.kickoff).getTime();
      return Math.abs(leftTime - now) - Math.abs(rightTime - now);
    })
    .slice(0, limit);
}
