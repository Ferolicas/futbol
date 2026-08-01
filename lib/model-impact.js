/* eslint-disable */
// lib/model-impact.js — builder de model.player_impact (FASE 4A). Mide el impacto
// del jugador por el rendimiento del EQUIPO con/sin él (decisión #6: impacto, no
// presencia). Set-based (un INSERT ... SELECT con CTEs). CommonJS.
//   buildPlayerImpact(pool, { playerIds? })  → full (TRUNCATE) si sin ids; incremental si ids.
//
// Definición (ventana = etapa del jugador en el club):
//   apps: por (player_id, team_id), [f,l] = min/max kickoff de sus apariciones (minutes>0).
//   agg : sobre los partidos del EQUIPO en [f,l], FILTER si el jugador jugó (minutes>0)
//         → "con"; si no → "sin". avg de goles/cards/fouls (team_match_stats) y penaltis
//         (SUM penalty_committed de player_match_stats, vía CTE tpen). n SEPARADO por
//         cobertura: n_with/n_without (goles), n_stats_* (cards/fouls), n_pen_* (penaltis).
//   se guarda cualquier par con al menos un partido "con" y uno "sin". Los n
//   permanecen visibles y la capa runtime amortigua el efecto según cobertura;
//   no existe un veto arbitrario de muestra.
//
// IMPORTANTE: es estado actual de serving y se calcula solo con partidos ya
// finalizados. El entrenamiento point-in-time del núcleo no lee esta tabla, por
// lo que este agregado nunca contamina sus validaciones con hechos futuros.

const isPool = (db) => typeof db?.connect === 'function' && typeof db?.totalCount === 'number';
async function buildPlayerImpact(pool, { playerIds = null, currentShare = null, _atomic = false } = {}) {
  if (!_atomic && isPool(pool)) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await buildPlayerImpact(client, { playerIds, currentShare, _atomic: true });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  const ids = (playerIds && playerIds.length) ? playerIds.map(Number) : null;
  if (ids) await pool.query(`DELETE FROM model.player_impact WHERE player_id = ANY($1::bigint[])`, [ids]);
  else await pool.query(`TRUNCATE model.player_impact`);
  const idClause = ids ? `AND player_id = ANY($1::bigint[])` : '';
  const params = ids ? [ids] : [];
  if (currentShare == null) {
    try {
      const { rows } = await pool.query(
        `SELECT weights->>'currentShare' AS share FROM prediction_models
         WHERE sport='football' AND market_key='__empirical_engine__'
           AND model_type='empirical-weighting' AND active=TRUE
         ORDER BY version DESC LIMIT 1`
      );
      currentShare = rows[0]?.share == null ? null : Number(rows[0].share);
    } catch {}
  }
  const activeShare = Math.max(0.55, Math.min(0.95, Number(currentShare) || 0.72));
  const historicalShare = 1 - activeShare;
  const blended = (column) => `CASE
    WHEN max(${column}) FILTER (WHERE is_current) IS NOT NULL
     AND max(${column}) FILTER (WHERE NOT is_current) IS NOT NULL
    THEN ${activeShare} * max(${column}) FILTER (WHERE is_current)
       + ${historicalShare} * max(${column}) FILTER (WHERE NOT is_current)
    ELSE coalesce(
      max(${column}) FILTER (WHERE is_current),
      max(${column}) FILTER (WHERE NOT is_current)
    ) END`;

  const r = await pool.query(
    `INSERT INTO model.player_impact
       (player_id, team_id, gf_with, gf_without, ga_with, ga_without, delta_gf, delta_ga,
        cards_with, cards_without, delta_cards, fouls_with, fouls_without, delta_fouls, n_stats_with, n_stats_without,
        pen_with, pen_without, delta_pen, n_pen_with, n_pen_without,
        n_with, n_without, determinant, updated_at)
     WITH apps AS (
       -- etapa del jugador en el club: rango de sus apariciones reales
       SELECT player_id, team_id, min(kickoff) AS f, max(kickoff) AS l,
              max(season) FILTER (WHERE season IS NOT NULL) AS current_season
       FROM model.player_match_stats
       WHERE minutes > 0 AND team_id IS NOT NULL ${idClause}
       GROUP BY player_id, team_id
     ), tpen AS (
       -- SOLO penaltis: total del equipo por fixture (player_match_stats no cubre todos)
       SELECT team_id, fixture_id,
              CASE WHEN count(penalty_committed)>0 THEN sum(penalty_committed) END AS team_pen
       FROM model.player_match_stats
       WHERE team_id IN (SELECT team_id FROM apps)
       GROUP BY team_id, fixture_id
     ), segmented AS (
       SELECT a.player_id, a.team_id,
         (tms.season IS NOT DISTINCT FROM a.current_season) AS is_current,
         avg(tms.goals_for)     FILTER (WHERE pl.fixture_id IS NOT NULL) AS gf_with,
         avg(tms.goals_for)     FILTER (WHERE pl.fixture_id IS NULL)     AS gf_without,
         avg(tms.goals_against) FILTER (WHERE pl.fixture_id IS NOT NULL) AS ga_with,
         avg(tms.goals_against) FILTER (WHERE pl.fixture_id IS NULL)     AS ga_without,
         -- cards (yellow+red) y fouls desde team_match_stats, misma pasada; n PROPIO
         avg(tms.yellow_for + tms.red_for) FILTER (WHERE pl.fixture_id IS NOT NULL) AS cards_with,
         avg(tms.yellow_for + tms.red_for) FILTER (WHERE pl.fixture_id IS NULL)     AS cards_without,
         avg(tms.fouls_for)     FILTER (WHERE pl.fixture_id IS NOT NULL) AS fouls_with,
         avg(tms.fouls_for)     FILTER (WHERE pl.fixture_id IS NULL)     AS fouls_without,
         count(tms.yellow_for)  FILTER (WHERE pl.fixture_id IS NOT NULL) AS n_stats_with,   -- cubre cards y fouls (mismo patrón NULL)
         count(tms.yellow_for)  FILTER (WHERE pl.fixture_id IS NULL)     AS n_stats_without,
         -- penaltis desde tpen, n PROPIO (cuenta solo fixtures con dato de jugador)
         avg(tpen.team_pen)     FILTER (WHERE pl.fixture_id IS NOT NULL) AS pen_with,
         avg(tpen.team_pen)     FILTER (WHERE pl.fixture_id IS NULL)     AS pen_without,
         count(tpen.team_pen)   FILTER (WHERE pl.fixture_id IS NOT NULL) AS n_pen_with,
         count(tpen.team_pen)   FILTER (WHERE pl.fixture_id IS NULL)     AS n_pen_without,
         count(tms.goals_for) FILTER (WHERE pl.fixture_id IS NOT NULL) AS n_with,
         count(tms.goals_for) FILTER (WHERE pl.fixture_id IS NULL)     AS n_without
       FROM apps a
       JOIN model.team_match_stats tms
         ON tms.team_id = a.team_id AND tms.kickoff >= a.f AND tms.kickoff <= a.l
       LEFT JOIN tpen
         ON tpen.team_id = a.team_id AND tpen.fixture_id = tms.fixture_id
       LEFT JOIN model.player_match_stats pl
         ON pl.fixture_id = tms.fixture_id AND pl.player_id = a.player_id
        AND pl.team_id = a.team_id AND pl.minutes > 0
       GROUP BY a.player_id, a.team_id,
                (tms.season IS NOT DISTINCT FROM a.current_season)
     ), agg AS (
       SELECT player_id, team_id,
         ${blended('gf_with')} AS gf_with,
         ${blended('gf_without')} AS gf_without,
         ${blended('ga_with')} AS ga_with,
         ${blended('ga_without')} AS ga_without,
         ${blended('cards_with')} AS cards_with,
         ${blended('cards_without')} AS cards_without,
         ${blended('fouls_with')} AS fouls_with,
         ${blended('fouls_without')} AS fouls_without,
         ${blended('pen_with')} AS pen_with,
         ${blended('pen_without')} AS pen_without,
         sum(n_stats_with) AS n_stats_with,
         sum(n_stats_without) AS n_stats_without,
         sum(n_pen_with) AS n_pen_with,
         sum(n_pen_without) AS n_pen_without,
         sum(n_with) AS n_with,
         sum(n_without) AS n_without
       FROM segmented
       GROUP BY player_id, team_id
       HAVING sum(n_with) >= 1 AND sum(n_without) >= 1
     )
     SELECT player_id, team_id, gf_with, gf_without, ga_with, ga_without,
            (gf_with - gf_without) AS delta_gf,
            (ga_with - ga_without) AS delta_ga,
            cards_with, cards_without, (cards_with - cards_without) AS delta_cards,
            fouls_with, fouls_without, (fouls_with - fouls_without) AS delta_fouls,
            n_stats_with, n_stats_without,
            pen_with, pen_without, (pen_with - pen_without) AS delta_pen,
            n_pen_with, n_pen_without,
            n_with, n_without,
            (abs(gf_with - gf_without) >= 0.5) AS determinant,
            now()
     FROM agg`, params);

  return { written: r.rowCount || 0 };
}

module.exports = { buildPlayerImpact };
