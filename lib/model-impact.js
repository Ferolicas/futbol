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
//   se guardan pares con n_with>=5 Y n_without>=5 (para inspección); el flag
//   determinant = abs(delta_gf)>=0.5 AND n_with>=20 AND n_without>=20 (señal real,
//   evita el ruido de muestra chica que con 0.3/n5 marcaba ~49% de los pares).
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
       (player_id, team_id, gf_with, gf_without, ga_with, ga_without, delta_gf, delta_ga,
        cards_with, cards_without, delta_cards, fouls_with, fouls_without, delta_fouls, n_stats_with, n_stats_without,
        pen_with, pen_without, delta_pen, n_pen_with, n_pen_without,
        n_with, n_without, determinant, updated_at)
     WITH apps AS (
       -- etapa del jugador en el club: rango de sus apariciones reales
       SELECT player_id, team_id, min(kickoff) AS f, max(kickoff) AS l
       FROM model.player_match_stats
       WHERE minutes > 0 AND team_id IS NOT NULL ${idClause}
       GROUP BY player_id, team_id
     ), tpen AS (
       -- SOLO penaltis: total del equipo por fixture (player_match_stats no cubre todos)
       SELECT team_id, fixture_id, sum(coalesce(penalty_committed, 0)) AS team_pen
       FROM model.player_match_stats
       WHERE team_id IN (SELECT team_id FROM apps)
       GROUP BY team_id, fixture_id
     ), agg AS (
       SELECT a.player_id, a.team_id,
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
         -- goles: n con count(*) (todos los partidos de la ventana) — base del determinant
         count(*) FILTER (WHERE pl.fixture_id IS NOT NULL) AS n_with,
         count(*) FILTER (WHERE pl.fixture_id IS NULL)     AS n_without
       FROM apps a
       JOIN model.team_match_stats tms
         ON tms.team_id = a.team_id AND tms.kickoff >= a.f AND tms.kickoff <= a.l
       LEFT JOIN tpen
         ON tpen.team_id = a.team_id AND tpen.fixture_id = tms.fixture_id
       LEFT JOIN model.player_match_stats pl
         ON pl.fixture_id = tms.fixture_id AND pl.player_id = a.player_id AND pl.minutes > 0
       GROUP BY a.player_id, a.team_id
       HAVING count(*) FILTER (WHERE pl.fixture_id IS NOT NULL) >= 5
          AND count(*) FILTER (WHERE pl.fixture_id IS NULL)     >= 5
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
            (abs(gf_with - gf_without) >= 0.5 AND n_with >= 20 AND n_without >= 20) AS determinant,
            now()
     FROM agg`, params);

  return { written: r.rowCount || 0 };
}

module.exports = { buildPlayerImpact };
