BEGIN;

-- API-Football serializa muchos contadores individuales iguales a cero como
-- JSON null. No se puede aplicar COALESCE(0) indiscriminadamente porque algunas
-- competiciones no ofrecen la métrica. La cobertura se valida por fixture y
-- equipo: la suma de jugadores debe reconciliar exactamente con el total real
-- del equipo. Solo entonces un null de un jugador que disputó minutos es cero.
WITH player_raw AS (
  SELECT r.ref_id::bigint AS fixture_id,
         NULLIF(tb#>>'{team,id}', '')::bigint AS team_id,
         NULLIF(pl#>>'{player,id}', '')::bigint AS player_id,
         NULLIF(ps#>>'{games,minutes}', '')::numeric::int AS minutes,
         NULLIF(ps#>>'{goals,total}', '')::numeric::int AS goals,
         NULLIF(ps#>>'{shots,total}', '')::numeric::int AS shots_total,
         NULLIF(ps#>>'{shots,on}', '')::numeric::int AS shots_on,
         NULLIF(ps#>>'{fouls,committed}', '')::numeric::int AS fouls_committed,
         NULLIF(ps#>>'{cards,yellow}', '')::numeric::int AS yellow,
         NULLIF(ps#>>'{cards,red}', '')::numeric::int AS red,
         NULLIF(ps->>'offsides', '')::numeric::int AS offsides
  FROM raw_api_payloads r
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(r.payload->'response')='array'
         THEN r.payload->'response' ELSE '[]'::jsonb END
  ) tb
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(tb->'players')='array'
         THEN tb->'players' ELSE '[]'::jsonb END
  ) pl
  CROSS JOIN LATERAL (
    SELECT CASE WHEN jsonb_typeof(pl->'statistics')='array'
                     AND jsonb_array_length(pl->'statistics')>0
                THEN (pl->'statistics')->0 ELSE '{}'::jsonb END AS ps
  ) stat
  WHERE r.endpoint='fixtures/players' AND r.sub_key=''
), team_totals AS (
  SELECT r.ref_id::bigint AS fixture_id,
         NULLIF(tb#>>'{team,id}', '')::bigint AS team_id,
         MAX(CASE WHEN s->>'type'='Total Shots' THEN NULLIF(regexp_replace(s->>'value','[^0-9.-]','','g'),'')::numeric::int END) AS shots_total,
         MAX(CASE WHEN s->>'type'='Shots on Goal' THEN NULLIF(regexp_replace(s->>'value','[^0-9.-]','','g'),'')::numeric::int END) AS shots_on,
         MAX(CASE WHEN s->>'type'='Fouls' THEN NULLIF(regexp_replace(s->>'value','[^0-9.-]','','g'),'')::numeric::int END) AS fouls,
         COALESCE(MAX(CASE WHEN s->>'type'='Yellow Cards' THEN NULLIF(regexp_replace(s->>'value','[^0-9.-]','','g'),'')::numeric::int END),0) AS yellow,
         COALESCE(MAX(CASE WHEN s->>'type'='Red Cards' THEN NULLIF(regexp_replace(s->>'value','[^0-9.-]','','g'),'')::numeric::int END),0) AS red,
         COALESCE(MAX(CASE WHEN s->>'type'='Offsides' THEN NULLIF(regexp_replace(s->>'value','[^0-9.-]','','g'),'')::numeric::int END),0) AS offsides
  FROM raw_api_payloads r
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(r.payload->'response')='array'
         THEN r.payload->'response' ELSE '[]'::jsonb END
  ) tb
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(tb->'statistics')='array'
         THEN tb->'statistics' ELSE '[]'::jsonb END
  ) s
  WHERE r.endpoint='fixtures/statistics' AND r.sub_key=''
  GROUP BY r.ref_id,tb#>>'{team,id}'
), fixture_goals AS (
  SELECT ref_id::bigint fixture_id,
         NULLIF(payload#>>'{teams,home,id}','')::bigint team_id,
         NULLIF(payload#>>'{goals,home}','')::numeric::int team_goals
  FROM raw_api_payloads WHERE endpoint='fixtures' AND sub_key=''
  UNION ALL
  SELECT ref_id::bigint,
         NULLIF(payload#>>'{teams,away,id}','')::bigint,
         NULLIF(payload#>>'{goals,away}','')::numeric::int
  FROM raw_api_payloads WHERE endpoint='fixtures' AND sub_key=''
), own_goals AS (
  SELECT r.ref_id::bigint fixture_id,
         NULLIF(e#>>'{team,id}','')::bigint team_id,
         count(*)::int own_goals
  FROM raw_api_payloads r
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(r.payload->'response')='array'
         THEN r.payload->'response' ELSE '[]'::jsonb END
  ) e
  WHERE r.endpoint='fixtures/events' AND r.sub_key=''
    AND e->>'type'='Goal' AND e->>'detail'='Own Goal'
  GROUP BY r.ref_id,e#>>'{team,id}'
), coverage AS (
  SELECT pr.fixture_id,pr.team_id,
         fg.team_goals,
         CASE WHEN fg.team_goals IS NULL THEN NULL
              ELSE GREATEST(0,fg.team_goals-COALESCE(og.own_goals,0)) END AS expected_player_goals,
         sum(COALESCE(pr.goals,0)) FILTER (WHERE pr.minutes>0) AS reported_goals,
         tt.shots_total AS expected_shots_total,
         sum(COALESCE(pr.shots_total,0)) FILTER (WHERE pr.minutes>0) AS reported_shots_total,
         tt.shots_on AS expected_shots_on,
         sum(COALESCE(pr.shots_on,0)) FILTER (WHERE pr.minutes>0) AS reported_shots_on,
         tt.fouls AS expected_fouls,
         sum(COALESCE(pr.fouls_committed,0)) FILTER (WHERE pr.minutes>0) AS reported_fouls,
         tt.yellow AS expected_yellow,
         sum(COALESCE(pr.yellow,0)) FILTER (WHERE pr.minutes>0) AS reported_yellow,
         tt.red AS expected_red,
         sum(COALESCE(pr.red,0)) FILTER (WHERE pr.minutes>0) AS reported_red,
         tt.offsides AS expected_offsides,
         sum(COALESCE(pr.offsides,0)) FILTER (WHERE pr.minutes>0) AS reported_offsides
  FROM player_raw pr
  LEFT JOIN fixture_goals fg USING (fixture_id,team_id)
  LEFT JOIN own_goals og USING (fixture_id,team_id)
  LEFT JOIN team_totals tt USING (fixture_id,team_id)
  GROUP BY pr.fixture_id,pr.team_id,fg.team_goals,og.own_goals,
           tt.shots_total,tt.shots_on,tt.fouls,tt.yellow,tt.red,tt.offsides
)
UPDATE model.player_match_stats m
SET goals = CASE WHEN pr.goals IS NOT NULL THEN pr.goals
                 WHEN pr.minutes>0 AND c.expected_player_goals IS NOT NULL
                      AND c.reported_goals=c.expected_player_goals THEN 0 ELSE NULL END,
    shots_total = CASE WHEN pr.shots_total IS NOT NULL THEN pr.shots_total
                       WHEN pr.minutes>0 AND c.expected_shots_total IS NOT NULL
                            AND c.reported_shots_total=c.expected_shots_total THEN 0 ELSE NULL END,
    shots_on = CASE WHEN pr.shots_on IS NOT NULL THEN pr.shots_on
                    WHEN pr.minutes>0 AND c.expected_shots_on IS NOT NULL
                         AND c.reported_shots_on=c.expected_shots_on THEN 0 ELSE NULL END,
    fouls_committed = CASE WHEN pr.fouls_committed IS NOT NULL THEN pr.fouls_committed
                           WHEN pr.minutes>0 AND c.expected_fouls IS NOT NULL
                                AND c.reported_fouls=c.expected_fouls THEN 0 ELSE NULL END,
    yellow = CASE WHEN pr.yellow IS NOT NULL THEN pr.yellow
                  WHEN pr.minutes>0 AND c.expected_yellow IS NOT NULL
                       AND c.reported_yellow=c.expected_yellow THEN 0 ELSE NULL END,
    red = CASE WHEN pr.red IS NOT NULL THEN pr.red
               WHEN pr.minutes>0 AND c.expected_red IS NOT NULL
                    AND c.reported_red=c.expected_red THEN 0 ELSE NULL END,
    offsides = CASE WHEN pr.offsides IS NOT NULL THEN pr.offsides
                    WHEN pr.minutes>0 AND c.expected_offsides IS NOT NULL
                         AND c.reported_offsides=c.expected_offsides THEN 0 ELSE NULL END,
    ingested_at=NOW()
FROM player_raw pr
JOIN coverage c USING (fixture_id,team_id)
WHERE m.fixture_id=pr.fixture_id AND m.player_id=pr.player_id;

COMMIT;
