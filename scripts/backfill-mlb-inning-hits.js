/* eslint-disable no-console */

// Completa hits por entrada usando exclusivamente el feed oficial MLB.
// Sin --run solo informa cuántos juegos faltan. El proceso es idempotente:
// nunca vuelve a pedir un fixture que ya conserva hitsByInning.

import { pgPool } from '../lib/db.js';
import { getMlbLiveGame } from '../lib/mlb-stats-api.js';

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || fallback;
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

function inningHits(live, side) {
  return (live?.innings || []).map(inning => Number(side === 'home' ? inning.homeHits : inning.awayHits) || 0);
}

async function main() {
  const season = option('season', String(new Date().getUTCFullYear()));
  const limit = Math.max(1, Math.min(10_000, Number(option('limit', '10000')) || 10_000));
  const concurrency = Math.max(1, Math.min(6, Number(option('concurrency', '4')) || 4));
  const run = process.argv.includes('--run');
  if (!/^\d{4}$/.test(season)) throw new Error('Temporada inválida; usa --season=YYYY');

  const { rows } = await pgPool.query(
    `SELECT m.fixture_id,m.provider_fixture_id,m.kickoff
       FROM baseball_engine_matches m
      WHERE m.status='FT' AND m.season=$1 AND m.competition_id='1'
        AND EXISTS (
          SELECT 1 FROM baseball_engine_team_stats t
           WHERE t.fixture_id=m.fixture_id AND NOT (t.stats ? 'hitsByInning')
        )
      ORDER BY m.kickoff DESC
      LIMIT $2`,
    [season, limit],
  );
  console.log(JSON.stringify({ season, pending: rows.length, run, concurrency }));
  if (!run || !rows.length) return;

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  await mapLimited(rows, concurrency, async (row, index) => {
    try {
      const live = await getMlbLiveGame(Number(row.provider_fixture_id));
      const home = inningHits(live, 'home');
      const away = inningHits(live, 'away');
      const homeTotal = home.reduce((sum, value) => sum + value, 0);
      const awayTotal = away.reduce((sum, value) => sum + value, 0);
      // Solo se persiste un feed final y reconciliado con el total oficial.
      if (!live?.isFinal || !home.length || homeTotal !== Number(live.home?.hits) || awayTotal !== Number(live.away?.hits)) {
        skipped += 1;
        return;
      }
      await pgPool.query(
        `UPDATE baseball_engine_team_stats
            SET stats=stats || jsonb_build_object(
              'hitsByInning', CASE WHEN is_home THEN $2::jsonb ELSE $3::jsonb END,
              'opponentHitsByInning', CASE WHEN is_home THEN $3::jsonb ELSE $2::jsonb END
            ), updated_at=now()
          WHERE fixture_id=$1`,
        [String(row.fixture_id), JSON.stringify(home), JSON.stringify(away)],
      );
      updated += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[mlb-inning-hits] ${row.fixture_id}: ${error.message}`);
    }
    if ((index + 1) % 100 === 0) console.log(JSON.stringify({ processed: index + 1, updated, skipped, failed }));
  });
  console.log(JSON.stringify({ ok: failed === 0, season, scanned: rows.length, updated, skipped, failed }, null, 2));
}

main()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await pgPool.end(); });
