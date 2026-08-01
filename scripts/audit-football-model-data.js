/* eslint-disable no-console */
// Auditoría reproducible de integridad: crudo API → hechos relacionales → perfiles.
// Solo lectura. Sale con código 2 si detecta una invariancia crítica rota.

try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 2,
});

const POISON = `(
  payload ? '__error' OR payload ? '__http' OR
  (jsonb_typeof(payload->'errors')='object' AND payload->'errors'<>'{}'::jsonb) OR
  (jsonb_typeof(payload->'errors')='array' AND jsonb_array_length(payload->'errors')>0)
)`;

async function one(name, sql) {
  const started = Date.now();
  const { rows } = await pool.query(sql);
  const value = rows[0] || {};
  console.log(`${name} (${Date.now() - started}ms)`);
  console.log(JSON.stringify(value, null, 2));
  return value;
}

const n = (value) => Number(value || 0);

(async () => {
  const raw = await one('raw', `
    SELECT count(*)::bigint total,
           count(DISTINCT endpoint)::int endpoints,
           count(*) FILTER (WHERE ${POISON})::int poison,
           min(fetched_at) oldest, max(fetched_at) newest
    FROM raw_api_payloads`);

  const ledger = await one('capture_ledger', `
    SELECT count(*)::int total,
           count(*) FILTER (WHERE resolved_at IS NULL)::int unresolved,
           count(*) FILTER (WHERE resolved_at IS NULL AND status='retry')::int retry,
           count(*) FILTER (WHERE resolved_at IS NULL AND status='empty')::int empty,
           count(*) FILTER (WHERE resolved_at IS NULL AND status='permanent')::int permanent,
           count(*) FILTER (WHERE resolved_at IS NULL AND next_retry_at<=now())::int due
    FROM api_capture_failures`);

  const rawToFacts = await one('raw_to_facts', `
    WITH finished AS (
      SELECT ref_id::bigint fixture_id
      FROM raw_api_payloads
      WHERE endpoint='fixtures' AND sub_key=''
        AND payload#>>'{fixture,status,short}' IN ('FT','AET','PEN')
    ), related AS (
      SELECT DISTINCT ref_id::bigint fixture_id
      FROM raw_api_payloads
      WHERE endpoint IN ('fixtures/statistics','fixtures/events','fixtures/players',
                         'fixtures/lineups','fixtures/halfstats')
         OR (endpoint='injuries' AND sub_key LIKE 'fx:%')
    )
    SELECT (SELECT count(*) FROM finished)::int finished_raw,
           (SELECT count(*) FROM finished f
             WHERE NOT EXISTS (SELECT 1 FROM model.matches m WHERE m.fixture_id=f.fixture_id))::int finished_missing_match,
           (SELECT count(*) FROM finished f
             WHERE (SELECT count(*) FROM model.team_match_stats t WHERE t.fixture_id=f.fixture_id)<>2)::int finished_without_two_team_facts,
           (SELECT count(*) FROM related r
             WHERE NOT EXISTS (SELECT 1 FROM raw_api_payloads f
                               WHERE f.endpoint='fixtures' AND f.sub_key='' AND f.ref_id=r.fixture_id))::int related_missing_fixture_raw`);

  if (n(rawToFacts.related_missing_fixture_raw)) await one('related_missing_fixture_samples', `
    SELECT jsonb_agg(to_jsonb(sample)) samples
    FROM (
      SELECT r.endpoint,r.ref_id,r.sub_key,r.season,r.fetched_at
      FROM raw_api_payloads r
      WHERE (r.endpoint IN ('fixtures/statistics','fixtures/events','fixtures/players',
                            'fixtures/lineups','fixtures/halfstats')
             OR (r.endpoint='injuries' AND r.sub_key LIKE 'fx:%'))
        AND NOT EXISTS (SELECT 1 FROM raw_api_payloads f
                        WHERE f.endpoint='fixtures' AND f.sub_key='' AND f.ref_id=r.ref_id)
      ORDER BY r.endpoint,r.ref_id LIMIT 10
    ) sample`);

  const playerRaw = await one('player_raw_to_facts', `
    WITH played AS (
      SELECT DISTINCT r.ref_id::bigint fixture_id,
             NULLIF(pl#>>'{player,id}', '')::bigint player_id,
             pl#>>'{player,name}' player_name
      FROM raw_api_payloads r
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(r.payload->'response')='array'
             THEN r.payload->'response' ELSE '[]'::jsonb END
      ) tb
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(tb->'players')='array'
             THEN tb->'players' ELSE '[]'::jsonb END
      ) pl
      WHERE r.endpoint='fixtures/players' AND r.sub_key=''
        AND NULLIF(pl#>>'{statistics,0,games,minutes}', '')::numeric>0
    )
    SELECT count(*)::int played_raw,
           count(*) FILTER (WHERE player_id IS NULL OR player_id<=0)::int without_valid_player_id,
           count(DISTINCT fixture_id) FILTER (WHERE player_id IS NULL OR player_id<=0)::int fixtures_without_valid_player_id,
           count(*) FILTER (WHERE player_id>0 AND NOT EXISTS (
             SELECT 1 FROM model.player_match_stats m
             WHERE m.fixture_id=played.fixture_id AND m.player_id=played.player_id
           ))::int known_player_missing_fact
    FROM played`);

  await one('unidentified_player_samples', `
    SELECT r.ref_id::bigint fixture_id,
           pl#>>'{player,id}' player_id,
           pl#>>'{player,name}' player_name,
           pl#>>'{statistics,0,games,minutes}' minutes
    FROM raw_api_payloads r
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(r.payload->'response')='array'
           THEN r.payload->'response' ELSE '[]'::jsonb END
    ) tb
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(tb->'players')='array'
           THEN tb->'players' ELSE '[]'::jsonb END
    ) pl
    WHERE r.endpoint='fixtures/players' AND r.sub_key=''
      AND NULLIF(pl#>>'{statistics,0,games,minutes}', '')::numeric>0
      AND COALESCE(NULLIF(pl#>>'{player,id}', '')::bigint,0)<=0
    ORDER BY r.ref_id LIMIT 5`);

  const modelFacts = await one('model_fact_integrity', `
    SELECT
      (SELECT count(*) FROM model.matches WHERE status IN ('FT','AET','PEN') AND result IS NULL)::int finished_without_result,
      (SELECT count(*) FROM model.team_match_stats t
        JOIN model.matches m USING (fixture_id)
        WHERE t.team_id NOT IN (m.home_team_id,m.away_team_id)
           OR t.opponent_id NOT IN (m.home_team_id,m.away_team_id))::int invalid_team_side,
      (SELECT count(*) FROM model.player_match_stats p
        JOIN model.matches m USING (fixture_id)
        WHERE p.team_id IS NOT NULL AND p.team_id NOT IN (m.home_team_id,m.away_team_id))::int invalid_player_team,
      (SELECT count(*) FROM model.player_match_stats p
        LEFT JOIN model.players d USING (player_id) WHERE d.player_id IS NULL)::int player_dimension_orphans,
      (SELECT count(*) FROM model.team_match_stats t
        LEFT JOIN model.teams d ON d.team_id=t.team_id WHERE d.team_id IS NULL)::int team_dimension_orphans,
      (SELECT count(*) FROM model.player_match_stats
        WHERE minutes<0 OR goals<0 OR shots_total<0 OR shots_on<0 OR fouls_committed<0
           OR yellow<0 OR red<0 OR offsides<0)::int negative_player_counters`);

  if (n(modelFacts.negative_player_counters)) await one('negative_player_counter_samples', `
    SELECT jsonb_agg(to_jsonb(sample)) samples
    FROM (
      SELECT fixture_id,player_id,team_id,minutes,goals,shots_total,shots_on,
             fouls_committed,yellow,red,offsides
      FROM model.player_match_stats
      WHERE minutes<0 OR goals<0 OR shots_total<0 OR shots_on<0 OR fouls_committed<0
         OR yellow<0 OR red<0 OR offsides<0
      ORDER BY fixture_id,player_id LIMIT 10
    ) sample`);

  const scoreConsistency = await one('score_consistency', `
    WITH pairs AS (
      SELECT m.fixture_id,m.ft_home,m.ft_away,
             max(t.goals_for) FILTER (WHERE t.team_id=m.home_team_id) hgf,
             max(t.goals_against) FILTER (WHERE t.team_id=m.home_team_id) hga,
             max(t.goals_for) FILTER (WHERE t.team_id=m.away_team_id) agf,
             max(t.goals_against) FILTER (WHERE t.team_id=m.away_team_id) aga
      FROM model.matches m
      JOIN model.team_match_stats t USING (fixture_id)
      WHERE m.status IN ('FT','AET','PEN')
      GROUP BY m.fixture_id,m.ft_home,m.ft_away
    )
    SELECT count(*)::int checked,
           count(*) FILTER (WHERE ft_home IS DISTINCT FROM hgf
                                  OR ft_away IS DISTINCT FROM hga
                                  OR ft_away IS DISTINCT FROM agf
                                  OR ft_home IS DISTINCT FROM aga)::int mismatches
    FROM pairs`);

  const playerCoverage = await one('player_counter_coverage', `
    SELECT count(*) FILTER (WHERE minutes>0)::bigint played,
           count(*) FILTER (WHERE minutes>0 AND goals IS NULL)::bigint goals_null,
           count(*) FILTER (WHERE minutes>0 AND shots_total IS NULL)::bigint shots_null,
           count(*) FILTER (WHERE minutes>0 AND shots_on IS NULL)::bigint sot_null,
           count(*) FILTER (WHERE minutes>0 AND fouls_committed IS NULL)::bigint fouls_null,
           count(*) FILTER (WHERE minutes>0 AND yellow IS NULL)::bigint yellow_null,
           count(*) FILTER (WHERE minutes>0 AND goals=0)::bigint goals_zero,
           count(*) FILTER (WHERE minutes>0 AND goals>0)::bigint goals_positive
    FROM model.player_match_stats`);

  await one('model_sizes', `
    SELECT (SELECT count(*) FROM model.matches)::bigint matches,
           (SELECT count(*) FROM model.team_match_stats)::bigint team_facts,
           (SELECT count(*) FROM model.player_match_stats)::bigint player_facts,
           (SELECT count(*) FROM model.team_profiles)::bigint team_profiles,
           (SELECT count(*) FROM model.player_profiles)::bigint player_profiles,
           (SELECT count(*) FROM model.player_impact)::bigint player_impact`);

  const critical = {
    poison: n(raw.poison),
    ledger_unresolved: n(ledger.unresolved),
    finished_missing_match: n(rawToFacts.finished_missing_match),
    finished_without_two_team_facts: n(rawToFacts.finished_without_two_team_facts),
    related_missing_fixture_raw: n(rawToFacts.related_missing_fixture_raw),
    known_player_missing_fact: n(playerRaw.known_player_missing_fact),
    finished_without_result: n(modelFacts.finished_without_result),
    invalid_team_side: n(modelFacts.invalid_team_side),
    invalid_player_team: n(modelFacts.invalid_player_team),
    player_dimension_orphans: n(modelFacts.player_dimension_orphans),
    team_dimension_orphans: n(modelFacts.team_dimension_orphans),
    negative_player_counters: n(modelFacts.negative_player_counters),
    score_mismatches: n(scoreConsistency.mismatches),
  };
  const failures = Object.entries(critical).filter(([, value]) => value !== 0);
  console.log('critical');
  console.log(JSON.stringify(critical, null, 2));
  if (failures.length) {
    console.error(`AUDIT FAILED: ${failures.map(([key, value]) => `${key}=${value}`).join(', ')}`);
    process.exitCode = 2;
  } else {
    console.log('AUDIT OK: 0 invariancias críticas rotas');
  }
  await pool.end();
})().catch(async (error) => {
  console.error('AUDIT FATAL', error?.stack || error);
  await pool.end().catch(() => {});
  process.exit(1);
});
