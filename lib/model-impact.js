/* eslint-disable */
// lib/model-impact.js — builder de model.player_impact (FASE 4A). Mide el impacto
// del jugador por el rendimiento del EQUIPO con/sin él (decisión #6: impacto, no
// presencia). Set-based (un INSERT ... SELECT con CTEs). CommonJS.
//   buildPlayerImpact(pool, { playerIds? })  → full (TRUNCATE) si sin ids; incremental si ids.
//
// Definición (ventana = etapa del jugador en el club):
//   apps: por (player_id, team_id), [f,l] = min/max kickoff de sus apariciones (minutes>0).
//   agg : sobre los partidos del EQUIPO en [f,l], FILTER si el jugador jugó (minutes>0)
//         → "con"; si no → "sin". avg(goals_for/against) y conteos por lado.
//   solo se guardan pares con n_with>=5 Y n_without>=5; determinant = abs(delta_gf)>=0.3.
//
// IMPORTANTE: estado actual = SOLO serving. El backtest NUNCA lee esta tabla
// (recomputa point-in-time desde los hechos con cutoff). Sin fuga.

async function buildPlayerImpact(pool, { playerIds = null } = {}) {
  const ids = (playerIds && playerIds.length) ? playerIds.map(Number) : null;
  if (ids) await pool.query(`DELETE FROM model.player_impact WHERE player_id = ANY($1::bigint[])`, [ids]);
  else await pool.query(`TRUNCATE model.player_impact`);
  const idClause = ids ? `AND player_id = ANY($1::bigint[])` : '';
  const params = ids ? [ids] : [];

  const r = await pool.query(
    `INSERT INTO model.player_impact
       (player_id, team_id, gf_with, gf_without, ga_with, ga_without,
        delta_gf, delta_ga, n_with, n_without, determinant, updated_at)
     WITH apps AS (
       -- etapa del jugador en el club: rango de sus apariciones reales
       SELECT player_id, team_id, min(kickoff) AS f, max(kickoff) AS l
       FROM model.player_match_stats
       WHERE minutes > 0 AND team_id IS NOT NULL ${idClause}
       GROUP BY player_id, team_id
     ), agg AS (
       SELECT a.player_id, a.team_id,
         avg(tms.goals_for)     FILTER (WHERE pl.fixture_id IS NOT NULL) AS gf_with,
         avg(tms.goals_for)     FILTER (WHERE pl.fixture_id IS NULL)     AS gf_without,
         avg(tms.goals_against) FILTER (WHERE pl.fixture_id IS NOT NULL) AS ga_with,
         avg(tms.goals_against) FILTER (WHERE pl.fixture_id IS NULL)     AS ga_without,
         count(*) FILTER (WHERE pl.fixture_id IS NOT NULL) AS n_with,
         count(*) FILTER (WHERE pl.fixture_id IS NULL)     AS n_without
       FROM apps a
       JOIN model.team_match_stats tms
         ON tms.team_id = a.team_id AND tms.kickoff >= a.f AND tms.kickoff <= a.l
       LEFT JOIN model.player_match_stats pl
         ON pl.fixture_id = tms.fixture_id AND pl.player_id = a.player_id AND pl.minutes > 0
       GROUP BY a.player_id, a.team_id
       HAVING count(*) FILTER (WHERE pl.fixture_id IS NOT NULL) >= 5
          AND count(*) FILTER (WHERE pl.fixture_id IS NULL)     >= 5
     )
     SELECT player_id, team_id, gf_with, gf_without, ga_with, ga_without,
            (gf_with - gf_without) AS delta_gf,
            (ga_with - ga_without) AS delta_ga,
            n_with, n_without,
            (abs(gf_with - gf_without) >= 0.3) AS determinant,
            now()
     FROM agg`, params);

  return { written: r.rowCount || 0 };
}

module.exports = { buildPlayerImpact };
