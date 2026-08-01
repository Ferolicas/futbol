BEGIN;

-- Reconstruye las estadísticas de alta frecuencia desde el payload crudo
-- válido. Un tipo ausente queda NULL (cobertura limitada), nunca cero. Para
-- tarjetas/offsides la API sí omite normalmente el tipo cuando el conteo es 0.
WITH raw_teams AS (
  SELECT r.ref_id::bigint AS fixture_id, team_block
  FROM raw_api_payloads r
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(r.payload->'response') = 'array'
         THEN r.payload->'response' ELSE '[]'::jsonb END
  ) AS team_block
  WHERE r.endpoint = 'fixtures/statistics'
    AND r.sub_key = ''
    AND NOT (r.payload ? '__error' OR r.payload ? '__http')
    AND NOT (jsonb_typeof(r.payload->'errors') = 'object' AND r.payload->'errors' <> '{}'::jsonb)
    AND jsonb_typeof(team_block->'statistics') = 'array'
    AND jsonb_array_length(team_block->'statistics') > 0
), values_by_team AS (
  SELECT fixture_id,
         NULLIF(team_block#>>'{team,id}', '')::bigint AS team_id,
         MAX(CASE WHEN stat->>'type' = 'Corner Kicks' THEN NULLIF(regexp_replace(stat->>'value', '[^0-9.-]', '', 'g'), '')::numeric END) AS corners,
         MAX(CASE WHEN stat->>'type' = 'Total Shots' THEN NULLIF(regexp_replace(stat->>'value', '[^0-9.-]', '', 'g'), '')::numeric END) AS shots,
         MAX(CASE WHEN stat->>'type' = 'Shots on Goal' THEN NULLIF(regexp_replace(stat->>'value', '[^0-9.-]', '', 'g'), '')::numeric END) AS sot,
         MAX(CASE WHEN stat->>'type' = 'Fouls' THEN NULLIF(regexp_replace(stat->>'value', '[^0-9.-]', '', 'g'), '')::numeric END) AS fouls,
         MAX(CASE WHEN stat->>'type' = 'Offsides' THEN NULLIF(regexp_replace(stat->>'value', '[^0-9.-]', '', 'g'), '')::numeric END) AS offsides,
         MAX(CASE WHEN stat->>'type' = 'Yellow Cards' THEN NULLIF(regexp_replace(stat->>'value', '[^0-9.-]', '', 'g'), '')::numeric END) AS yellow,
         MAX(CASE WHEN stat->>'type' = 'Red Cards' THEN NULLIF(regexp_replace(stat->>'value', '[^0-9.-]', '', 'g'), '')::numeric END) AS red,
         MAX(CASE WHEN stat->>'type' = 'Ball Possession' THEN NULLIF(regexp_replace(stat->>'value', '[^0-9.-]', '', 'g'), '')::numeric END) AS possession,
         MAX(CASE WHEN stat->>'type' = 'expected_goals' THEN NULLIF(regexp_replace(stat->>'value', '[^0-9.-]', '', 'g'), '')::numeric END) AS xg
  FROM raw_teams
  CROSS JOIN LATERAL jsonb_array_elements(team_block->'statistics') AS stat
  GROUP BY fixture_id, team_block#>>'{team,id}'
), repaired AS (
  UPDATE model.team_match_stats t
  SET corners_for = round(own.corners)::int,
      corners_against = round(opp.corners)::int,
      shots_for = round(own.shots)::int,
      shots_against = round(opp.shots)::int,
      sot_for = round(own.sot)::int,
      sot_against = round(opp.sot)::int,
      fouls_for = round(own.fouls)::int,
      fouls_against = round(opp.fouls)::int,
      offsides_for = round(COALESCE(own.offsides, 0))::int,
      offsides_against = CASE WHEN opp.team_id IS NULL THEN NULL ELSE round(COALESCE(opp.offsides, 0))::int END,
      yellow_for = round(COALESCE(own.yellow, 0))::int,
      yellow_against = CASE WHEN opp.team_id IS NULL THEN NULL ELSE round(COALESCE(opp.yellow, 0))::int END,
      red_for = round(COALESCE(own.red, 0))::int,
      red_against = CASE WHEN opp.team_id IS NULL THEN NULL ELSE round(COALESCE(opp.red, 0))::int END,
      had_red_for = COALESCE(own.red, 0) > 0,
      had_red_against = CASE WHEN opp.team_id IS NULL THEN NULL ELSE COALESCE(opp.red, 0) > 0 END,
      possession = own.possession,
      xg_for = own.xg,
      xg_against = opp.xg,
      stats_present = TRUE,
      ingested_at = NOW()
  FROM values_by_team own
  LEFT JOIN values_by_team opp
    ON opp.fixture_id = own.fixture_id AND opp.team_id <> own.team_id
  WHERE t.fixture_id = own.fixture_id AND t.team_id = own.team_id
  RETURNING t.fixture_id
)
UPDATE model.matches m
SET stats_available = TRUE
WHERE EXISTS (SELECT 1 FROM repaired r WHERE r.fixture_id = m.fixture_id);

COMMIT;
