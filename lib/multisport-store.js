import { getMultisportConfig } from './multisport-config.js';

function ident(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const cleaned = value.replace(/%|,/g, '').trim();
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedKey(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

const STAT_ALIASES = {
  hits: ['hits'], errors: ['errors'],
  rebounds: ['reboundstotal', 'totalrebounds', 'totreb', 'reboundstotalrebounds', 'rebounds'],
  assists: ['assists'],
  steals: ['steals'], blocks: ['blocks'],
  offensiveRebounds: ['offreb', 'offensiverebounds'],
  defensiveRebounds: ['defreb', 'defensiverebounds'],
  personalFouls: ['pfouls', 'personalfouls'],
  fieldGoalsMade: ['fgm', 'fieldgoalsmade'], fieldGoalsAttempted: ['fga', 'fieldgoalsattempted'],
  freeThrowsMade: ['ftm', 'freethrowsmade'], freeThrowsAttempted: ['fta', 'freethrowsattempted'],
  threePointersMade: ['threepointersmade', 'threepointsmade', 'threepointgoalstotal', 'tpm', '3pointsmade', 'threepoints'],
  turnovers: ['turnoverstotal', 'turnovers', 'turnover'],
  totalYards: ['yardstotal', 'totalyards', 'yards'],
  passingYards: ['passingtotal', 'passingyards', 'passyards'],
  rushingYards: ['rushingstotal', 'rushingtotal', 'rushingyards', 'rushyards'],
  touchdowns: ['touchdowns', 'totaltouchdowns'],
  points: ['points', 'pts'],
  homeRuns: ['homeruns', 'homerun'],
  totalBases: ['totalbases'],
  rbis: ['rbis', 'rbi', 'runsbattedin'],
  strikeouts: ['strikeouts'],
  receptions: ['totalreceptions', 'receptions'],
  receivingYards: ['receivingyards', 'recyards'],
  tackles: ['tackles', 'totaltackles'],
  passingTouchdowns: ['passingtouchdowns'],
  rushingTouchdowns: ['rushingtouchdowns'],
  receivingTouchdowns: ['receivingtouchdowns'],
  interceptionsThrown: ['passinginterceptionsthrown', 'interceptionsthrown'],
  passingSacksTaken: ['passingsackstaken'], rushingAttempts: ['rushingattempts'],
  targets: ['targets'], fumbles: ['fumbles'],
  interceptions: ['interceptionstotal', 'interceptions'],
  sacks: ['sackstotal', 'sacks'],
  penalties: ['penaltiestotal', 'penalties'],
  firstDowns: ['firstdownstotal', 'firstdowns'],
  fumblesLost: ['turnoverslostfumbles', 'fumbleslost'],
  runs: ['runs'], doubles: ['doubles'], triples: ['triples'],
  walks: ['walks', 'baseonballs'], battingStrikeouts: ['battingstrikeouts'],
  stolenBases: ['stolenbases'], walksAllowed: ['walksallowed'],
  hitsAllowed: ['hitsallowed'], earnedRuns: ['earnedruns'], pitchesThrown: ['pitchesthrown'],
};

function pairsFromStatistics(statistics) {
  if (!statistics) return [];
  if (Array.isArray(statistics)) {
    return statistics.flatMap((entry) => {
      if (entry && typeof entry === 'object' && ('type' in entry || 'name' in entry)) {
        return [[entry.type || entry.name, entry.value ?? entry.total]];
      }
      return pairsFromStatistics(entry);
    });
  }
  if (typeof statistics !== 'object') return [];
  return Object.entries(statistics).flatMap(([key, value]) => {
    if (value && typeof value === 'object') return pairsFromStatistics(value).map(([child, childValue]) => [`${key}${child}`, childValue]);
    return [[key, value]];
  });
}

export function normalizeTeamStatistics(statistics) {
  const pairs = pairsFromStatistics(statistics);
  const normalized = {};
  for (const [canonical, aliases] of Object.entries(STAT_ALIASES)) {
    const hit = pairs.find(([key]) => aliases.includes(normalizedKey(key)));
    if (hit) {
      const compoundCount = canonical === 'penalties'
        ? String(hit[1] ?? '').match(/^\s*(\d+)\s*[-/]/)?.[1]
        : null;
      normalized[canonical] = numberOrNull(compoundCount ?? hit[1]);
    }
  }
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value != null));
}

function sameTeam(raw, team) {
  const rawId = String(raw?.team?.id || raw?.id || raw?.teamId || '');
  if (rawId && [String(team?.id || ''), String(team?.providerTeamId || '')].includes(rawId)) return true;
  const left = normalizedKey(raw?.team?.name || raw?.name || raw?.teamName);
  const right = normalizedKey(team?.name);
  return !!left && !!right && (left.includes(right) || right.includes(left));
}

function providerTeam(details, game, side) {
  const direct = details?.teams?.[side];
  if (direct && !Array.isArray(details.teams)) return direct;
  const collection = Array.isArray(details?.teams) ? details.teams : [];
  return collection.find((row) => sameTeam(row, game.teams?.[side])) || null;
}

function providerPlayers(details, game, side) {
  const direct = details?.teams?.[side]?.players;
  if (Array.isArray(direct)) return direct;
  const rows = Array.isArray(details?.players) ? details.players : [];
  const teamRow = rows.find((row) => sameTeam(row, game.teams?.[side]));
  if (Array.isArray(teamRow?.players)) return teamRow.players;
  if (Array.isArray(teamRow?.statistics) && !teamRow?.player) return teamRow.statistics;
  // API-NBA y el fallback API-Basketball entregan una fila por jugador.
  return rows.filter((row) => sameTeam(row, game.teams?.[side]));
}

function hasProviderDetails(details) {
  if (!details) return false;
  if (Array.isArray(details.teams) && details.teams.length > 0) return true;
  if (details.teams && !Array.isArray(details.teams)
    && Object.values(details.teams).some((team) => team != null)) return true;
  if (Array.isArray(details.players) && details.players.length > 0) return true;
  return ['home', 'away'].some((side) => Array.isArray(details.periods?.[side]) && details.periods[side].length > 0);
}

function starterIds(players) {
  return (players || []).filter((player) => player?.starter === true || player?.starter === '1' || player?.game?.position === 'starter')
    .map((player) => String(player.id || player.player?.id || player.personId || '')).filter(Boolean);
}

function periodScores(game, details, side) {
  const own = game.periods?.[side];
  const periods = Array.isArray(own) && own.length ? own : details?.periods?.[side];
  if (!Array.isArray(periods)) return [];
  return periods.map(numberOrNull);
}

function factsForGame(game, details, side) {
  const opponent = side === 'home' ? 'away' : 'home';
  const teamDetail = providerTeam(details, game, side);
  const opponentDetail = providerTeam(details, game, opponent);
  const players = providerPlayers(details, game, side);
  const opponentPlayers = providerPlayers(details, game, opponent);
  const stats = normalizeTeamStatistics(teamDetail?.statistics || teamDetail?.stats || teamDetail);
  const opponentStats = normalizeTeamStatistics(opponentDetail?.statistics || opponentDetail?.stats || opponentDetail);
  // Distingue un boxscore consultado (aunque la competición sea limitada) de
  // una caída transitoria donde solo se pudo guardar el marcador.
  stats._detailsAvailable = hasProviderDetails(details);
  if (stats.hits == null && numberOrNull(game.teams?.[side]?.hits) != null) stats.hits = numberOrNull(game.teams[side].hits);
  if (stats.errors == null && numberOrNull(game.teams?.[side]?.errors) != null) stats.errors = numberOrNull(game.teams[side].errors);
  if (opponentStats.hits == null && numberOrNull(game.teams?.[opponent]?.hits) != null) opponentStats.hits = numberOrNull(game.teams[opponent].hits);
  if (opponentStats.errors == null && numberOrNull(game.teams?.[opponent]?.errors) != null) opponentStats.errors = numberOrNull(game.teams[opponent].errors);
  for (const [key, value] of Object.entries(opponentStats)) {
    stats[`opponent${key[0].toUpperCase()}${key.slice(1)}`] = value;
  }
  const team = game.teams[side];
  const opponentTeam = game.teams[opponent];
  const ownStarter = team?.probablePitcherId || teamDetail?.starterId || null;
  const otherStarter = opponentTeam?.probablePitcherId || opponentDetail?.starterId || null;
  const starters = starterIds(players);
  const opponentStarters = starterIds(opponentPlayers);
  if (ownStarter != null) stats.starterId = String(ownStarter);
  if (otherStarter != null) stats.opponentStarterId = String(otherStarter);
  if (starters.length) stats.starters = starters;
  if (opponentStarters.length) stats.opponentStarters = opponentStarters;

  const scoreFor = numberOrNull(game.scores?.[side]?.total);
  const scoreAgainst = numberOrNull(game.scores?.[opponent]?.total);
  return {
    fixtureId: String(game.id),
    kickoff: game.date,
    teamId: String(team.id),
    opponentId: String(opponentTeam.id),
    competitionId: String(game.league?.id || ''),
    season: String(game.season || ''),
    isHome: side === 'home',
    scoreFor,
    scoreAgainst,
    periodScores: periodScores(game, details, side),
    periodScoresAgainst: periodScores(game, details, opponent),
    stats,
    result: scoreFor == null || scoreAgainst == null ? null : (scoreFor > scoreAgainst ? 'W' : scoreFor < scoreAgainst ? 'L' : 'D'),
  };
}

function playerFactsForGame(game, details, side) {
  const opponent = side === 'home' ? 'away' : 'home';
  return providerPlayers(details, game, side).map((player) => {
    const playerId = String(player.id || player.player?.id || player.personId || '');
    if (!playerId) return null;
    const stats = normalizeTeamStatistics(player.stats || player.statistics || player.game?.statistics || player);
    return {
      fixtureId: String(game.id), kickoff: game.date, playerId,
      playerName: player.name || player.player?.name
        || `${player.player?.firstname || ''} ${player.player?.lastname || ''}`.trim()
        || player.person?.displayName || player.person?.fullName || null,
      teamId: String(game.teams[side].id), opponentId: String(game.teams[opponent].id),
      competitionId: String(game.league?.id || ''), season: String(game.season || ''),
      isStarter: player.starter === true || player.starter === '1' || player.game?.position === 'starter',
      position: player.position || player.pos || player.player?.position || null,
      photo: player.photo || player.image || player.player?.photo || null,
      stats,
    };
  }).filter(Boolean);
}

export async function persistSportSchedule(pool, sport, date, games) {
  const config = getMultisportConfig(sport);
  const table = ident(`${config.tablePrefix}_match_schedule`);
  const kickoffTimes = games.map((game) => ({
    fixtureId: String(game.id), providerFixtureId: game.providerFixtureId,
    kickoff: new Date(game.date).getTime(),
    expectedEnd: new Date(game.date).getTime() + config.expectedDurationMs,
  })).filter((row) => Number.isFinite(row.kickoff));
  await pool.query(
    `INSERT INTO ${table}(date, schedule, updated_at) VALUES($1,$2::jsonb,now())
     ON CONFLICT(date) DO UPDATE SET schedule=EXCLUDED.schedule, updated_at=now()`,
    [date, JSON.stringify({ fixtureCount: games.length, kickoffTimes, source: [...new Set(games.map((game) => game.dataProvider))] })],
  );
}

export async function persistSportGames(pool, sport, games) {
  const config = getMultisportConfig(sport);
  const table = ident(`${config.tablePrefix}_engine_matches`);
  if (!games.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const game of games) {
      await client.query(
        `INSERT INTO ${table}(
          fixture_id,provider,provider_fixture_id,competition_id,season,kickoff,status,
          home_team_id,away_team_id,home_team,away_team,home_logo,away_logo,
          home_score,away_score,periods,raw,finalized_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,now())
        ON CONFLICT(fixture_id) DO UPDATE SET
          provider=EXCLUDED.provider,provider_fixture_id=EXCLUDED.provider_fixture_id,
          competition_id=EXCLUDED.competition_id,season=EXCLUDED.season,kickoff=EXCLUDED.kickoff,
          status=EXCLUDED.status,home_team_id=EXCLUDED.home_team_id,away_team_id=EXCLUDED.away_team_id,
          home_team=EXCLUDED.home_team,away_team=EXCLUDED.away_team,home_logo=EXCLUDED.home_logo,
          away_logo=EXCLUDED.away_logo,home_score=EXCLUDED.home_score,away_score=EXCLUDED.away_score,
          periods=EXCLUDED.periods,raw=EXCLUDED.raw,
          finalized_at=COALESCE(${table}.finalized_at,EXCLUDED.finalized_at),updated_at=now()`,
        [
          String(game.id), game.dataProvider, String(game.providerFixtureId || game.id), String(game.league?.id || ''), String(game.season || ''), game.date,
          game.status?.short || 'NS', String(game.teams?.home?.id || ''), String(game.teams?.away?.id || ''), game.teams?.home?.name,
          game.teams?.away?.name, game.teams?.home?.logo || game.teams?.home?.fallbackLogo || null,
          game.teams?.away?.logo || game.teams?.away?.fallbackLogo || null,
          numberOrNull(game.scores?.home?.total), numberOrNull(game.scores?.away?.total), JSON.stringify(game.periods || {}),
          JSON.stringify(game.raw || {}), game.status?.isFinal ? new Date().toISOString() : null,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function ingestFinalSportGame(pool, sport, game, details = null, options = {}) {
  if (!game?.status?.isFinal) return { ingested: false, reason: 'not-final' };
  const config = getMultisportConfig(sport);
  const matchesTable = ident(`${config.tablePrefix}_engine_matches`);
  const statsTable = ident(`${config.tablePrefix}_engine_team_stats`);
  const playerStatsTable = ident(`${config.tablePrefix}_engine_player_stats`);
  const home = factsForGame(game, details, 'home');
  const away = factsForGame(game, details, 'away');
  const playerFacts = [...playerFactsForGame(game, details, 'home'), ...playerFactsForGame(game, details, 'away')];
  if (home.scoreFor == null || home.scoreAgainst == null) return { ingested: false, reason: 'missing-score' };

  if (!options.skipPersist) await persistSportGames(pool, config.key, [game]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const fact of [home, away]) {
      await client.query(
        `INSERT INTO ${statsTable}(
          fixture_id,kickoff,team_id,opponent_id,competition_id,season,is_home,
          score_for,score_against,period_scores,period_scores_against,stats,result,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,now())
        ON CONFLICT(fixture_id,team_id) DO UPDATE SET
          kickoff=EXCLUDED.kickoff,opponent_id=EXCLUDED.opponent_id,competition_id=EXCLUDED.competition_id,
          season=EXCLUDED.season,is_home=EXCLUDED.is_home,score_for=EXCLUDED.score_for,
          score_against=EXCLUDED.score_against,period_scores=EXCLUDED.period_scores,
          period_scores_against=EXCLUDED.period_scores_against,stats=EXCLUDED.stats,
          result=EXCLUDED.result,updated_at=now()`,
        [fact.fixtureId, fact.kickoff, fact.teamId, fact.opponentId, fact.competitionId, fact.season, fact.isHome,
          fact.scoreFor, fact.scoreAgainst, JSON.stringify(fact.periodScores), JSON.stringify(fact.periodScoresAgainst), JSON.stringify(fact.stats), fact.result],
      );
    }
    for (const player of playerFacts) {
      await client.query(
        `INSERT INTO ${playerStatsTable}(
          fixture_id,kickoff,player_id,player_name,team_id,opponent_id,competition_id,
          season,is_starter,position,photo,stats,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,now())
        ON CONFLICT(fixture_id,player_id) DO UPDATE SET
          kickoff=EXCLUDED.kickoff,player_name=EXCLUDED.player_name,team_id=EXCLUDED.team_id,
          opponent_id=EXCLUDED.opponent_id,competition_id=EXCLUDED.competition_id,
          season=EXCLUDED.season,is_starter=EXCLUDED.is_starter,position=EXCLUDED.position,
          photo=COALESCE(EXCLUDED.photo,${playerStatsTable}.photo),stats=EXCLUDED.stats,updated_at=now()`,
        [player.fixtureId, player.kickoff, player.playerId, player.playerName, player.teamId, player.opponentId,
          player.competitionId, player.season, player.isStarter, player.position, player.photo, JSON.stringify(player.stats)],
      );
    }
    await client.query(`UPDATE ${matchesTable} SET finalized_at=COALESCE(finalized_at,now()), updated_at=now() WHERE fixture_id=$1`, [String(game.id)]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { ingested: true, fixtureId: String(game.id) };
}

export async function saveSportAnalysis(pool, sport, game, payload) {
  const config = getMultisportConfig(sport);
  const table = ident(`${config.tablePrefix}_match_analysis`);
  await pool.query(
    `INSERT INTO ${table}(
      fixture_id,date,league_id,league_name,country,home_team_id,away_team_id,
      home_team,away_team,status,start_time,analysis,odds,best_odds,probabilities,
      combinada,data_quality,cache_version,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18,now())
    ON CONFLICT(fixture_id) DO UPDATE SET
      date=EXCLUDED.date,league_id=EXCLUDED.league_id,league_name=EXCLUDED.league_name,
      country=EXCLUDED.country,home_team_id=EXCLUDED.home_team_id,away_team_id=EXCLUDED.away_team_id,
      home_team=EXCLUDED.home_team,away_team=EXCLUDED.away_team,status=EXCLUDED.status,start_time=EXCLUDED.start_time,
      analysis=EXCLUDED.analysis,odds=EXCLUDED.odds,best_odds=EXCLUDED.best_odds,
      probabilities=EXCLUDED.probabilities,combinada=EXCLUDED.combinada,
      data_quality=EXCLUDED.data_quality,cache_version=EXCLUDED.cache_version,updated_at=now()`,
    [
      String(game.id), new Date(game.date).toISOString().slice(0, 10), String(game.league?.id || ''), game.league?.name || config.competitionLabel,
      game.country?.name || 'USA', String(game.teams?.home?.id || ''), String(game.teams?.away?.id || ''), game.teams?.home?.name,
      game.teams?.away?.name, game.status?.short || 'NS', game.date, JSON.stringify(payload.analysis || {}),
      JSON.stringify(payload.odds?.raw || []), JSON.stringify(payload.odds || {}), JSON.stringify(payload.probabilities || {}),
      JSON.stringify(payload.combinada || {}), JSON.stringify(payload.dataQuality || {}), Number(payload.cacheVersion || 1),
    ],
  );
}

export async function saveSportPrediction(pool, sport, game, prediction) {
  const config = getMultisportConfig(sport);
  const table = ident(`${config.tablePrefix}_engine_predictions`);
  await pool.query(
    `INSERT INTO ${table}(fixture_id,kickoff,competition_id,season,home_team_id,away_team_id,prediction,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now(),now())
     ON CONFLICT(fixture_id) DO UPDATE SET prediction=EXCLUDED.prediction,updated_at=now()`,
    [String(game.id), game.date, String(game.league?.id || ''), String(game.season || ''), String(game.teams.home.id), String(game.teams.away.id), JSON.stringify(prediction)],
  );
}

export async function getSportAnalyses(pool, sport, fixtureIds) {
  const config = getMultisportConfig(sport);
  if (!fixtureIds.length) return [];
  const table = ident(`${config.tablePrefix}_match_analysis`);
  const { rows } = await pool.query(`SELECT * FROM ${table} WHERE fixture_id::text = ANY($1::text[])`, [fixtureIds.map(String)]);
  return rows;
}

export const multisportStoreInternals = { factsForGame, playerFactsForGame, pairsFromStatistics };
