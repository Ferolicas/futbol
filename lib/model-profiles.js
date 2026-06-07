/* eslint-disable */
// lib/model-profiles.js — builder de perfiles (FASE 2F). Agrega los HECHOS
// (model.team_match_stats / model.player_match_stats) → model.team_profiles /
// model.player_profiles. Todo set-based (INSERT ... SELECT ... GROUP BY).
//   buildTeamProfiles(pool, { teamIds? })   → full (TRUNCATE) si sin ids; incremental si ids.
//   buildPlayerProfiles(pool, { playerIds? })
// IMPORTANTE: los perfiles son ESTADO ACTUAL (solo serving). El entrenamiento NUNCA
// los lee — computa point-in-time desde los hechos (kickoff < fecha). Sin fuga.
// CommonJS.

const TEAM_COMP_CAT = { domestic_league: 'domestic_league', continental: 'continental_club', cup: 'domestic_cup' };
const PLAYER_SCOPE_CAT = { domestic_league: ['domestic_league'], national_team: ['national_team', 'friendly_intl'], continental: ['continental_club'], cup: ['domestic_cup'] };

// Orden de columnas = orden de expresiones (TEAM_AGG / PLAYER_AGG). NO desordenar.
const TEAM_COLS = ['sample_n', 'goals_for_avg', 'goals_against_avg', 'shots_for_avg', 'shots_against_avg', 'sot_for_avg', 'corners_for_avg', 'corners_against_avg', 'fouls_avg', 'offsides_avg', 'yellow_avg', 'red_rate', 'xg_for_avg', 'xg_against_avg', 'scoring_rate', 'clean_sheet_rate', 'btts_rate', 'over05_rate', 'over15_rate', 'over25_rate', 'over35_rate'];
const TEAM_AGG = `count(*), avg(goals_for), avg(goals_against), avg(shots_for), avg(shots_against), avg(sot_for), avg(corners_for), avg(corners_against), avg(fouls_for), avg(offsides_for), avg(yellow_for), avg((red_for>0)::int), avg(xg_for), avg(xg_against), avg((scored)::int), avg((clean_sheet)::int), avg((btts)::int), avg((total_goals>0.5)::int), avg((total_goals>1.5)::int), avg((total_goals>2.5)::int), avg((total_goals>3.5)::int)`;

const PLAYER_COLS = ['sample_n', 'minutes_avg', 'goals_avg', 'assists_avg', 'shots_avg', 'sot_avg', 'fouls_avg', 'yellow_avg', 'rating_avg', 'appearance_rate', 'scoring_rate', 'shots_on_rate', 'anytime_scorer_rate', 'card_rate', 'shots_per90', 'sot_per90', 'fouls_per90', 'cards_per90', 'last_played_date'];
const PLAYER_AGG = `count(*), avg(minutes), avg(goals), avg(assists), avg(shots_total), avg(shots_on), avg(fouls_committed), avg(yellow), avg(rating), avg((is_starter)::int), (sum(goals)::real/NULLIF(sum(minutes),0)*90), avg((shots_on>0)::int), avg((goals>0)::int), avg(((coalesce(yellow,0)+coalesce(red,0))>0)::int), (sum(shots_total)::real/NULLIF(sum(minutes),0)*90), (sum(shots_on)::real/NULLIF(sum(minutes),0)*90), (sum(fouls_committed)::real/NULLIF(sum(minutes),0)*90), (sum(coalesce(yellow,0)+coalesce(red,0))::real/NULLIF(sum(minutes),0)*90), max(kickoff)::date`;

async function buildTeamProfiles(pool, { teamIds = null, minN = 3 } = {}) {
  const ids = (teamIds && teamIds.length) ? teamIds.map(Number) : null;
  if (ids) await pool.query(`DELETE FROM model.team_profiles WHERE team_id = ANY($1::bigint[])`, [ids]);
  else await pool.query(`TRUNCATE model.team_profiles`);
  const idClause = ids ? `AND team_id = ANY($1::bigint[])` : '';
  const params = ids ? [ids] : [];
  const venueClause = (v) => v === 'all' ? '' : `AND is_home=${v === 'home' ? 'true' : 'false'}`;
  const compClause = (c) => c === 'all' ? '' : `AND competition_category='${TEAM_COMP_CAT[c]}'`;
  const phaseClause = (p) => p === 'all' ? '' : `AND phase IN ('knockout','final')`;
  let written = 0;
  for (const v of ['all', 'home', 'away']) for (const c of ['all', 'domestic_league', 'continental', 'cup']) for (const p of ['all', 'knockout']) {
    let r = await pool.query(
      `INSERT INTO model.team_profiles (team_id,scope_venue,scope_competition,scope_phase,time_window,${TEAM_COLS},updated_at)
       SELECT team_id,'${v}','${c}','${p}','career',${TEAM_AGG},now() FROM model.team_match_stats
       WHERE true ${venueClause(v)} ${compClause(c)} ${phaseClause(p)} ${idClause}
       GROUP BY team_id HAVING count(*)>=${minN}`, params);
    written += r.rowCount || 0;
    r = await pool.query(
      `INSERT INTO model.team_profiles (team_id,scope_venue,scope_competition,scope_phase,time_window,${TEAM_COLS},updated_at)
       SELECT team_id,'${v}','${c}','${p}','s'||season,${TEAM_AGG},now() FROM model.team_match_stats
       WHERE season IS NOT NULL ${venueClause(v)} ${compClause(c)} ${phaseClause(p)} ${idClause}
       GROUP BY team_id,season HAVING count(*)>=${minN}`, params);
    written += r.rowCount || 0;
  }
  // last10 (forma reciente): solo comp=all, phase=all; por venue.
  for (const v of ['all', 'home', 'away']) {
    const r = await pool.query(
      `INSERT INTO model.team_profiles (team_id,scope_venue,scope_competition,scope_phase,time_window,${TEAM_COLS},updated_at)
       SELECT team_id,'${v}','all','all','last10',${TEAM_AGG},now() FROM (
         SELECT *, row_number() OVER (PARTITION BY team_id ORDER BY kickoff DESC) rn FROM model.team_match_stats
         WHERE true ${venueClause(v)} ${idClause}
       ) t WHERE rn<=10 GROUP BY team_id HAVING count(*)>=${minN}`, params);
    written += r.rowCount || 0;
  }
  return { written };
}

async function buildPlayerProfiles(pool, { playerIds = null, minN = 3 } = {}) {
  const ids = (playerIds && playerIds.length) ? playerIds.map(Number) : null;
  if (ids) await pool.query(`DELETE FROM model.player_profiles WHERE player_id = ANY($1::bigint[])`, [ids]);
  else await pool.query(`TRUNCATE model.player_profiles`);
  const idClause = ids ? `AND player_id = ANY($1::bigint[])` : '';
  const params = ids ? [ids] : [];
  const scopeClause = (s) => s === 'all' ? '' : `AND competition_category IN (${PLAYER_SCOPE_CAT[s].map(x => `'${x}'`).join(',')})`;
  let written = 0;
  for (const s of ['all', 'domestic_league', 'national_team', 'continental', 'cup']) {
    let r = await pool.query(
      `INSERT INTO model.player_profiles (player_id,scope,time_window,${PLAYER_COLS},updated_at)
       SELECT player_id,'${s}','career',${PLAYER_AGG},now() FROM model.player_match_stats
       WHERE minutes>0 ${scopeClause(s)} ${idClause}
       GROUP BY player_id HAVING count(*)>=${minN}`, params);
    written += r.rowCount || 0;
    r = await pool.query(
      `INSERT INTO model.player_profiles (player_id,scope,time_window,${PLAYER_COLS},updated_at)
       SELECT player_id,'${s}','s'||season,${PLAYER_AGG},now() FROM model.player_match_stats
       WHERE minutes>0 AND season IS NOT NULL ${scopeClause(s)} ${idClause}
       GROUP BY player_id,season HAVING count(*)>=${minN}`, params);
    written += r.rowCount || 0;
  }
  // last10 (últimas 10 apariciones): scope=all.
  const r = await pool.query(
    `INSERT INTO model.player_profiles (player_id,scope,time_window,${PLAYER_COLS},updated_at)
     SELECT player_id,'all','last10',${PLAYER_AGG},now() FROM (
       SELECT *, row_number() OVER (PARTITION BY player_id ORDER BY kickoff DESC) rn FROM model.player_match_stats WHERE minutes>0 ${idClause}
     ) t WHERE rn<=10 GROUP BY player_id HAVING count(*)>=${minN}`, params);
  written += r.rowCount || 0;
  return { written };
}

module.exports = { buildTeamProfiles, buildPlayerProfiles };
