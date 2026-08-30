/* eslint-disable no-console */

// Completa los córners reales de primera parte de 2026 con el desglose
// autoritativo que API-Football devuelve mediante `half=true`. Idempotente:
// solo procesa fixtures finalizados que todavía conservan corners_1h en null.

import { createRequire } from 'node:module';
import { pgPool } from '../lib/db.js';

const require = createRequire(import.meta.url);
const { footballApiRequest, closeFootballApiClient } = require('../lib/football-api-client.cjs');

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

async function mapLimited(items, concurrency, mapper) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await mapper(items[index], index);
    }
  });
  await Promise.all(runners);
}

function stat(teamBlock, period, type) {
  const entry = (teamBlock?.[period] || []).find((item) => item.type === type);
  if (entry?.value == null || entry.value === '') return null;
  const number = Number(entry.value);
  return Number.isFinite(number) ? number : null;
}

function teamCorners(teamBlock) {
  const full = stat(teamBlock, 'statistics', 'Corner Kicks');
  let first = stat(teamBlock, 'statistics_1h', 'Corner Kicks');
  let second = stat(teamBlock, 'statistics_2h', 'Corner Kicks');
  if (first == null && full != null && second != null) first = Math.max(0, full - second);
  if (second == null && full != null && first != null) second = Math.max(0, full - first);
  return { full, first, second };
}

async function persist(row, home, away) {
  const firstHalf = { home: home.first, away: away.first, total: home.first + away.first };
  const secondHalf = home.second != null && away.second != null
    ? { home: home.second, away: away.second, total: home.second + away.second }
    : null;
  const fullTime = home.full != null && away.full != null
    ? { home: home.full, away: away.full, total: home.full + away.full }
    : null;
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE model.team_match_stats
          SET corners_1h=COALESCE(corners_1h,CASE WHEN team_id=$2 THEN $4 WHEN team_id=$3 THEN $5 ELSE NULL END),
              corners_2h=CASE
                WHEN team_id=$2 THEN COALESCE(corners_2h,$6)
                WHEN team_id=$3 THEN COALESCE(corners_2h,$7)
                ELSE corners_2h
              END
        WHERE fixture_id=$1 AND team_id IN ($2,$3)`,
      [row.fixture_id, row.home_team_id, row.away_team_id, home.first, away.first, home.second, away.second],
    );
    const payload = {
      fixtureId: Number(row.fixture_id),
      leagueId: Number(row.competition_id) || null,
      season: Number(row.season) || null,
      teams: { home: Number(row.home_team_id), away: Number(row.away_team_id) },
      firstHalf: { corners: firstHalf },
      ...(secondHalf ? { secondHalf: { corners: secondHalf } } : {}),
      ...(fullTime ? { fullTime: { corners: fullTime } } : {}),
      backfilledAt: new Date().toISOString(),
      source: 'api-football:fixtures/statistics?half=true',
    };
    await client.query(
      `INSERT INTO raw_api_payloads (endpoint,ref_type,ref_id,season,sub_key,payload,fetched_at)
       VALUES ('fixtures/halfstats','fixture',$1,$2,'',$3::jsonb,NOW())
       ON CONFLICT (endpoint,ref_id,sub_key)
       DO UPDATE SET payload=jsonb_set(
                       jsonb_set(
                         jsonb_set(
                           raw_api_payloads.payload || (EXCLUDED.payload - 'firstHalf' - 'secondHalf' - 'fullTime'),
                           '{firstHalf}',
                           COALESCE(NULLIF(raw_api_payloads.payload->'firstHalf','null'::jsonb),'{}'::jsonb)
                             || COALESCE(EXCLUDED.payload->'firstHalf','{}'::jsonb),
                           true
                         ),
                         '{secondHalf}',
                         COALESCE(NULLIF(raw_api_payloads.payload->'secondHalf','null'::jsonb),'{}'::jsonb)
                           || COALESCE(EXCLUDED.payload->'secondHalf','{}'::jsonb),
                         true
                       ),
                       '{fullTime}',
                       COALESCE(NULLIF(raw_api_payloads.payload->'fullTime','null'::jsonb),'{}'::jsonb)
                         || COALESCE(EXCLUDED.payload->'fullTime','{}'::jsonb),
                       true
                     ),
                     season=COALESCE(EXCLUDED.season,raw_api_payloads.season),fetched_at=NOW()`,
      [row.fixture_id, row.season, JSON.stringify(payload)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const from = option('from', '2026-01-01');
  const limit = Math.max(1, Math.min(50_000, Number(option('limit', '50000')) || 50_000));
  const concurrency = Math.max(1, Math.min(24, Number(option('concurrency', '12')) || 12));
  const run = process.argv.includes('--run');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error('Fecha inválida; usa --from=YYYY-MM-DD');

  const { rows } = await pgPool.query(
    `SELECT m.fixture_id,m.competition_id,m.season,m.home_team_id,m.away_team_id,m.kickoff
       FROM model.matches m
      WHERE m.status IN ('FT','AET','PEN') AND m.kickoff >= $1::date
        AND EXISTS (
          SELECT 1 FROM model.team_match_stats s
           WHERE s.fixture_id=m.fixture_id AND s.corners_1h IS NULL
        )
      ORDER BY m.kickoff,m.fixture_id
      LIMIT $2`,
    [from, limit],
  );
  console.log(JSON.stringify({ from, pending: rows.length, run, concurrency }));
  if (!run || !rows.length) return;

  let updated = 0;
  let unavailable = 0;
  let failed = 0;
  await mapLimited(rows, concurrency, async (row, index) => {
    try {
      const { response } = await footballApiRequest(
        `/fixtures/statistics?fixture=${row.fixture_id}&half=true`,
        { retries: 2, timeoutMs: 30_000 },
      );
      const homeBlock = (response || []).find((team) => Number(team.team?.id) === Number(row.home_team_id));
      const awayBlock = (response || []).find((team) => Number(team.team?.id) === Number(row.away_team_id));
      const home = teamCorners(homeBlock);
      const away = teamCorners(awayBlock);
      if (home.first == null || away.first == null) {
        unavailable += 1;
      } else {
        await persist(row, home, away);
        updated += 1;
      }
    } catch (error) {
      failed += 1;
      console.warn(`[football-first-half-corners] ${row.fixture_id}: ${error.message}`);
    }
    const processed = index + 1;
    if (processed % 100 === 0 || processed === rows.length) {
      console.log(JSON.stringify({ processed, total: rows.length, updated, unavailable, failed }));
    }
  });
  console.log(JSON.stringify({ ok: failed === 0, from, scanned: rows.length, updated, unavailable, failed }, null, 2));
  if (failed) process.exitCode = 1;
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    await Promise.allSettled([pgPool.end(), closeFootballApiClient()]);
  });
