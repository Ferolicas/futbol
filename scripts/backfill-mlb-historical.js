/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Backfill MLB histórico para entrenar el modelo ML baseball.
//
// Descarga 3 endpoints de MLB Stats API (gratis, sin key) y los persiste
// en raw_api_payloads. NO descarga play-by-play ni feed/live.
//
//   1) endpoint='mlb-schedule'        ref_id=gamePk      sub_key=''
//      → game completo del /schedule (probable pitchers, linescore, status).
//        Cubre features 1-6, 9, 10. ~5-10 KB por juego.
//
//   2) endpoint='mlb-pitcher-season'  ref_id=pitcher_id  sub_key=season
//      → {era, whip, k9, ip} extraído del /people/{id}/stats (1 fila por
//        pitcher × temporada). Cubre features 7-8. ~1 KB por entry.
//
//   3) endpoint='mlb-boxscore'        ref_id=gamePk      sub_key='boxscore'
//      → /game/{gamePk}/boxscore SOLO si game.status.detailedState='Final'.
//        Útil para features futuras (lineup vs pitcher, bullpen usage).
//        ~30-50 KB por juego.
//
// REGLAS:
//   - ON CONFLICT DO NOTHING en los 3 endpoints (idempotente).
//   - Checkpoint reanudable: lee el SET de (ref_id,sub_key) ya escrito por
//     endpoint antes de empezar y skipea esos. El schedule SIEMPRE se re-pide
//     (es barato: chunks de 7 días, ~100 chunks total) y los inserts ya
//     hechos son no-op.
//   - Concurrency 5 (MLB Stats API es gratuita pero conviene no martillar).
//   - AbortSignal.timeout(45_000) en todas las llamadas.
//   - Progress cada 100 entries procesadas por endpoint.
//
// USO (en VPS, con setsid nohup para que sobreviva al logout SSH):
//
//   cd /apps/futbol && setsid nohup node --env-file=.env \
//     scripts/backfill-mlb-historical.js \
//     > /tmp/bf_mlb.log 2>&1 < /dev/null & disown
//
//   tail -f /tmp/bf_mlb.log
//
// Args opcionales:
//   --start=YYYY-MM-DD   (default 2025-03-01 — primer día relevante de la 2025)
//   --end=YYYY-MM-DD     (default = hoy en UTC)
//   --skip-boxscores     (no bajar mlb-boxscore, solo schedule+pitcher-season)
//   --concurrency=N      (default 5)
// ────────────────────────────────────────────────────────────────────────

try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const { Pool } = require('pg');

// ── Args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argVal = (name, def) => {
  const a = argv.find(s => s.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : def;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const todayUtc = new Date().toISOString().split('T')[0];
const START_DATE   = argVal('start', '2025-03-01');
const END_DATE     = argVal('end',   todayUtc);
const SKIP_BOXES   = hasFlag('skip-boxscores');
const CONCURRENCY  = Number(argVal('concurrency', '5')) || 5;

const STATS_API = 'https://statsapi.mlb.com/api';
const PROGRESS_EVERY = 100;
const CHUNK_DAYS = 7;
const FETCH_TIMEOUT_MS = 45_000;

// ── Helpers ─────────────────────────────────────────────────────────────
function makePool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: Math.max(5, CONCURRENCY + 2),
  });
}

async function fetchJson(path, attempt = 1) {
  const url = `${STATS_API}${path}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (attempt < 3) {
      // backoff 1s, 3s
      await new Promise(r => setTimeout(r, attempt * 2000));
      return fetchJson(path, attempt + 1);
    }
    throw new Error(`fetch ${path}: ${e.message}`);
  }
}

// Parse "25.2" innings (25 entradas + 2 outs) → 25.667 entradas decimales.
function parseInnings(ip) {
  if (ip == null) return 0;
  const n = Number(ip);
  if (!Number.isFinite(n)) return 0;
  const whole = Math.floor(n);
  const outs = Math.round((n - whole) * 10);
  return whole + outs / 3;
}

// Iterador de chunks [start, end] inclusivo, ventanas de CHUNK_DAYS días.
function* chunks(startStr, endStr) {
  const start = new Date(startStr + 'T00:00:00Z');
  const end = new Date(endStr + 'T00:00:00Z');
  let cur = new Date(start);
  while (cur <= end) {
    const chunkEnd = new Date(cur);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + (CHUNK_DAYS - 1));
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    yield {
      start: cur.toISOString().split('T')[0],
      end:   chunkEnd.toISOString().split('T')[0],
    };
    cur = new Date(chunkEnd);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}

async function mapPool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await fn(items[idx], idx); }
      catch (e) { console.warn(`  [warn] item ${idx} failed: ${e.message}`); }
    }
  }));
}

// ── 1) SCHEDULE ─────────────────────────────────────────────────────────
async function backfillSchedule(pool) {
  console.log(`\n[schedule] ventana ${START_DATE} → ${END_DATE}, chunks de ${CHUNK_DAYS} días`);
  const all = [...chunks(START_DATE, END_DATE)];
  const t0 = Date.now();

  const gamePks = new Set();
  const finalGamePks = new Set();
  const pitcherSeasons = new Set();   // "pitcher_id|season"
  let totalGames = 0, inserted = 0, skipped = 0;

  for (let i = 0; i < all.length; i++) {
    const { start, end } = all[i];
    let data;
    try {
      data = await fetchJson(`/v1/schedule?sportId=1&startDate=${start}&endDate=${end}&hydrate=probablePitcher,linescore,team`);
    } catch (e) {
      console.warn(`[schedule] chunk ${start}→${end} FAILED: ${e.message}`);
      continue;
    }
    const games = (data.dates || []).flatMap(d => d.games || []);

    for (const g of games) {
      if (!g.gamePk) continue;
      gamePks.add(g.gamePk);
      const season = new Date(g.gameDate || g.officialDate || `${start}T00:00:00Z`).getUTCFullYear();
      const isFinal = g.status?.detailedState === 'Final';
      if (isFinal) finalGamePks.add(g.gamePk);

      const hp = g.teams?.home?.probablePitcher?.id;
      const ap = g.teams?.away?.probablePitcher?.id;
      if (hp && season) pitcherSeasons.add(`${hp}|${season}`);
      if (ap && season) pitcherSeasons.add(`${ap}|${season}`);

      const ins = await pool.query(
        `INSERT INTO raw_api_payloads (endpoint, ref_type, ref_id, season, sub_key, payload, fetched_at)
         VALUES ('mlb-schedule', 'fixture', $1, $2, '', $3::jsonb, NOW())
         ON CONFLICT (endpoint, ref_id, sub_key) DO NOTHING
         RETURNING 1`,
        [g.gamePk, season || null, JSON.stringify(g)]
      );
      if (ins.rowCount > 0) inserted++; else skipped++;
      totalGames++;
    }

    if ((i + 1) % 10 === 0 || i === all.length - 1) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`[schedule] chunk ${i + 1}/${all.length} ${start}→${end} | games chunk=${games.length} total=${totalGames} new=${inserted} dup=${skipped} pitchers=${pitcherSeasons.size} final=${finalGamePks.size} | ${elapsed}s`);
    }
  }

  console.log(`[schedule] DONE — games=${totalGames} unique=${gamePks.size} final=${finalGamePks.size} pitcher-seasons=${pitcherSeasons.size} inserted=${inserted} dup=${skipped} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return { gamePks, finalGamePks, pitcherSeasons };
}

// ── 2) PITCHER SEASONS ──────────────────────────────────────────────────
async function backfillPitcherSeasons(pool, pitcherSeasons) {
  const { rows: existing } = await pool.query(
    `SELECT ref_id, sub_key FROM raw_api_payloads WHERE endpoint='mlb-pitcher-season'`
  );
  const done = new Set(existing.map(r => `${r.ref_id}|${r.sub_key}`));
  const todo = [...pitcherSeasons].filter(k => !done.has(k));
  console.log(`\n[pitcher] ${pitcherSeasons.size} pitcher-seasons únicos | done=${done.size} todo=${todo.length}`);
  if (todo.length === 0) return;

  const t0 = Date.now();
  let processed = 0, wrote = 0, noStats = 0, failed = 0;

  await mapPool(todo, CONCURRENCY, async (k) => {
    const [pidStr, seasonStr] = k.split('|');
    const pid = Number(pidStr), season = Number(seasonStr);
    let data;
    try {
      data = await fetchJson(`/v1/people/${pid}/stats?stats=season&season=${season}&group=pitching`);
    } catch (e) { failed++; return; }

    const splits = data?.stats?.[0]?.splits || [];
    const stat = splits[0]?.stat;
    if (!stat) { noStats++; return; }

    const ip = parseInnings(stat.inningsPitched);
    const strikeOuts = Number(stat.strikeOuts) || 0;
    const payload = {
      pitcher_id: pid,
      season,
      era:        stat.era != null ? Number(stat.era) : null,
      whip:       stat.whip != null ? Number(stat.whip) : null,
      k9:         ip > 0 ? (strikeOuts * 9) / ip : null,
      ip,
      gamesPlayed:    Number(stat.gamesPlayed) || 0,
      gamesStarted:   Number(stat.gamesStarted) || 0,
      strikeOuts,
      wins:           Number(stat.wins) || 0,
      losses:         Number(stat.losses) || 0,
    };

    const ins = await pool.query(
      `INSERT INTO raw_api_payloads (endpoint, ref_type, ref_id, season, sub_key, payload, fetched_at)
       VALUES ('mlb-pitcher-season', 'team', $1, $2, $3, $4::jsonb, NOW())
       ON CONFLICT (endpoint, ref_id, sub_key) DO NOTHING
       RETURNING 1`,
      [pid, season, String(season), JSON.stringify(payload)]
    );
    if (ins.rowCount > 0) wrote++;
    processed++;
    if (processed % PROGRESS_EVERY === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`[pitcher] ${processed}/${todo.length} | wrote=${wrote} noStats=${noStats} failed=${failed} | ${elapsed}s`);
    }
  });

  console.log(`[pitcher] DONE — processed=${processed}/${todo.length} wrote=${wrote} noStats=${noStats} failed=${failed} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// ── 3) BOXSCORES (solo Final) ───────────────────────────────────────────
async function backfillBoxscores(pool, finalGamePks) {
  if (SKIP_BOXES) { console.log('\n[boxscore] --skip-boxscores activado, omitido'); return; }

  const { rows: existing } = await pool.query(
    `SELECT ref_id FROM raw_api_payloads WHERE endpoint='mlb-boxscore' AND sub_key='boxscore'`
  );
  const done = new Set(existing.map(r => Number(r.ref_id)));
  const todo = [...finalGamePks].filter(p => !done.has(p));
  console.log(`\n[boxscore] ${finalGamePks.size} juegos finalizados | done=${done.size} todo=${todo.length}`);
  if (todo.length === 0) return;

  const t0 = Date.now();
  let processed = 0, wrote = 0, failed = 0;

  await mapPool(todo, CONCURRENCY, async (gamePk) => {
    let data;
    try {
      data = await fetchJson(`/v1/game/${gamePk}/boxscore`);
    } catch (e) { failed++; return; }

    const ins = await pool.query(
      `INSERT INTO raw_api_payloads (endpoint, ref_type, ref_id, season, sub_key, payload, fetched_at)
       VALUES ('mlb-boxscore', 'fixture', $1, NULL, 'boxscore', $2::jsonb, NOW())
       ON CONFLICT (endpoint, ref_id, sub_key) DO NOTHING
       RETURNING 1`,
      [gamePk, JSON.stringify(data)]
    );
    if (ins.rowCount > 0) wrote++;
    processed++;
    if (processed % PROGRESS_EVERY === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const rate = processed / Math.max(1, Date.now() - t0) * 1000;
      const etaSec = (todo.length - processed) / Math.max(rate, 0.001);
      console.log(`[boxscore] ${processed}/${todo.length} | wrote=${wrote} failed=${failed} | ${elapsed}s · ETA ${Math.round(etaSec)}s`);
    }
  });

  console.log(`[boxscore] DONE — processed=${processed}/${todo.length} wrote=${wrote} failed=${failed} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// ── MAIN ────────────────────────────────────────────────────────────────
(async () => {
  console.log('=================================================');
  console.log('  MLB Historical Backfill — raw_api_payloads');
  console.log('=================================================');
  console.log(`Window:        ${START_DATE} → ${END_DATE}`);
  console.log(`Concurrency:   ${CONCURRENCY}`);
  console.log(`Skip boxscores:${SKIP_BOXES}`);
  console.log('');

  const pool = makePool();
  const tStart = Date.now();
  try {
    const { finalGamePks, pitcherSeasons } = await backfillSchedule(pool);
    await backfillPitcherSeasons(pool, pitcherSeasons);
    await backfillBoxscores(pool, finalGamePks);

    // Resumen final con SELECT COUNT(*) por endpoint, sirve como auditoría
    // contra el `wc -l /tmp/bf_mlb.log | grep DONE`.
    const { rows: cs } = await pool.query(
      `SELECT endpoint, COUNT(*)::int AS rows
       FROM raw_api_payloads
       WHERE endpoint IN ('mlb-schedule','mlb-pitcher-season','mlb-boxscore')
       GROUP BY endpoint ORDER BY endpoint`
    );
    console.log('\n──────────────────────────────────────────────');
    console.log('RESUMEN raw_api_payloads (post-backfill)');
    for (const r of cs) console.log(`  ${r.endpoint.padEnd(22)} ${r.rows.toLocaleString()} filas`);
    const elapsed = ((Date.now() - tStart) / 1000).toFixed(0);
    console.log(`──────────────────────────────────────────────`);
    console.log(`✓ ALL DONE in ${elapsed}s (${(elapsed / 60).toFixed(1)} min)`);
  } catch (e) {
    console.error('\nFATAL:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
