// scripts/model/2b-ingest-facts.mjs
// FASE 2B — Ingesta de hechos desde raw_api_payloads → schema model.
//   node --env-file=.env.local scripts/model/2b-ingest-facts.mjs --only-team=290   (verificación)
//   node --env-file=.env.local scripts/model/2b-ingest-facts.mjs --resume          (backfill completo, reanudable)
//
// Idempotente exacto: por fixture (en transacción) → upsert dims + matches;
// DELETE hijos WHERE fixture_id + bulk-INSERT. Re-correr = mismo estado.
// Reutiliza buildActuals (lib/adn.js, verificado) para los hechos de equipo.
// NO toca raw_api_payloads ni la app — solo escribe en el schema `model`.
import pg from 'pg';
import { buildActuals } from '../../lib/adn.js';

const args = Object.fromEntries(process.argv.slice(2).map(s => { const m = s.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] === '' ? true : m[2]] : [s, true]; }));
const BATCH = Number(args.batch) || 400;
const ONLY_TEAM = args['only-team'] ? Number(args['only-team']) : null;
const LIMIT = args.limit ? Number(args.limit) : null;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 4 });

// ── Normalizador numérico (contrato 2A): número | "82" | "82%" | null | "" → número|null ──
const num = (v) => { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null; const n = parseFloat(String(v).replace('%', '').trim()); return isFinite(n) ? n : null; };
const int = (v) => { const n = num(v); return n == null ? null : Math.round(n); };
const resp = (p) => (p && p.response) ? p.response : (Array.isArray(p) ? p : []);
const FINISHED = new Set(['FT', 'AET', 'PEN']);

// ── Clasificación de competencia (categoría → scope de jugador + has_table) ──
const NATIONAL = new Set([1, 4, 5, 6, 7, 9, 10, 32, 33, 34, 35, 36, 37]);   // WC, Euro, Nations, CopaAm, qualifiers, friendlies(10)
const CONTINENTAL_CLUB = new Set([2, 3, 848, 13, 11, 26, 17, 16]);          // CL, EL, Conf, Libertadores, Sudamericana, CONCACAF, AFC, ClubWC
function classifyCategory(leagueId, type) {
  if (NATIONAL.has(leagueId)) return leagueId === 10 ? 'friendly_intl' : 'national_team';
  if (String(type).toLowerCase() === 'cup') return CONTINENTAL_CLUB.has(leagueId) ? 'continental_club' : 'domestic_cup';
  return 'domestic_league';
}
const phaseOf = (round) => { const r = String(round || '').toLowerCase(); if (/\bfinal\b/.test(r) && !/semi|quarter|round of|1\/8/.test(r)) return 'final'; if (/semi|quarter|round of|1\/8|knockout|play-?off|elimination/.test(r)) return 'knockout'; if (/group/.test(r)) return 'group'; return 'regular'; };
const matchdayOf = (round) => { const m = String(round || '').match(/(\d+)\s*$/); return m ? Number(m[1]) : null; };
const statVal = (arr, teamId, type) => { const t = (arr || []).find(s => s.team?.id === teamId); const v = (t?.statistics || []).find(s => s.type === type)?.value; return num(v); };
const teamHasStats = (arr, teamId) => { const t = (arr || []).find(s => s.team?.id === teamId); return !!(t && Array.isArray(t.statistics) && t.statistics.length); };

// ── Helpers SQL ──
async function upsertOne(c, table, cols, row, conflict, update) {
  const ph = cols.map((_, i) => `$${i + 1}`).join(',');
  const set = update.map(k => `${k}=EXCLUDED.${k}`).join(',');
  await c.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph}) ON CONFLICT (${conflict}) DO UPDATE SET ${set}`, cols.map(k => row[k]));
}
async function bulkInsert(c, table, cols, rows, onConflict = '') {
  if (!rows.length) return;
  const params = []; const tuples = rows.map(r => `(${cols.map(k => { params.push(r[k]); return `$${params.length}`; }).join(',')})`);
  await c.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')} ${onConflict}`, params);
}

// ── Procesa UN fixture (transacción) ──
async function processFixture(c, fx, rel) {
  const fid = fx.fixture?.id; if (!fid) return;
  const league = fx.league || {}, lid = league.id, season = league.season;
  const cat = classifyCategory(lid, league.type);
  const homeId = fx.teams?.home?.id, awayId = fx.teams?.away?.id;
  const finished = FINISHED.has(fx.fixture?.status?.short);

  // dims
  await upsertOne(c, 'model.competitions', ['competition_id', 'name', 'country', 'type', 'category', 'is_national'],
    { competition_id: lid, name: league.name, country: league.country, type: league.type, category: cat, is_national: cat === 'national_team' || cat === 'friendly_intl' },
    'competition_id', ['name', 'country', 'type', 'category', 'is_national']);
  if (season != null) await upsertOne(c, 'model.competition_seasons', ['competition_id', 'season', 'has_table'],
    { competition_id: lid, season, has_table: cat === 'domestic_league' }, 'competition_id,season', ['has_table']);
  for (const t of [fx.teams?.home, fx.teams?.away]) if (t?.id) await upsertOne(c, 'model.teams',
    ['team_id', 'name', 'is_national'], { team_id: t.id, name: t.name, is_national: cat === 'national_team' || cat === 'friendly_intl' }, 'team_id', ['name']);

  const stArr = resp(rel.stats), evArr = resp(rel.events), plArr = resp(rel.players), luArr = resp(rel.lineups), injArr = resp(rel.injuries);
  const statsPresent = teamHasStats(stArr, homeId) || teamHasStats(stArr, awayId);
  const playersPresent = plArr.length > 0;

  // matches
  await upsertOne(c, 'model.matches',
    ['fixture_id', 'competition_id', 'season', 'round', 'matchday', 'phase', 'kickoff', 'status', 'home_team_id', 'away_team_id', 'venue_id', 'referee', 'ft_home', 'ft_away', 'ht_home', 'ht_away', 'et_home', 'et_away', 'result', 'stats_available', 'players_available'],
    { fixture_id: fid, competition_id: lid, season, round: league.round, matchday: matchdayOf(league.round), phase: phaseOf(league.round), kickoff: fx.fixture?.date, status: fx.fixture?.status?.short, home_team_id: homeId, away_team_id: awayId, venue_id: fx.fixture?.venue?.id, referee: fx.fixture?.referee, ft_home: fx.score?.fulltime?.home ?? fx.goals?.home, ft_away: fx.score?.fulltime?.away ?? fx.goals?.away, ht_home: fx.score?.halftime?.home, ht_away: fx.score?.halftime?.away, et_home: fx.score?.extratime?.home, et_away: fx.score?.extratime?.away, result: finished ? ((fx.goals?.home ?? 0) > (fx.goals?.away ?? 0) ? 'H' : (fx.goals?.home ?? 0) < (fx.goals?.away ?? 0) ? 'A' : 'D') : null, stats_available: statsPresent, players_available: playersPresent },
    'fixture_id', ['competition_id', 'season', 'round', 'matchday', 'phase', 'kickoff', 'status', 'home_team_id', 'away_team_id', 'venue_id', 'referee', 'ft_home', 'ft_away', 'ht_home', 'ht_away', 'et_home', 'et_away', 'result', 'stats_available', 'players_available']);

  // limpiar hijos (idempotencia exacta)
  for (const t of ['team_match_stats', 'player_match_stats', 'match_events', 'lineups', 'match_injuries'])
    await c.query(`DELETE FROM model.${t} WHERE fixture_id=$1`, [fid]);

  // team_match_stats (2 filas) — reusa buildActuals + possession/xg de statistics
  const a = finished ? buildActuals(fx, rel.stats || null, rel.events || null, rel.halfstats || null) : null;
  if (a) {
    const mkTeam = (side, teamId, oppId, isHome) => {
      const o = side === 'home' ? 'away' : 'home';
      return {
        fixture_id: fid, team_id: teamId, opponent_id: oppId, competition_id: lid, competition_category: cat, season,
        kickoff: fx.fixture?.date, is_home: isHome, phase: phaseOf(league.round),
        result: a.result == null ? null : (a.result === 'D' ? 'D' : ((a.result === 'H') === isHome ? 'W' : 'L')),
        goals_for: a.goals?.[side], goals_against: a.goals?.[o], total_goals: a.goals?.total,
        btts: a.goals?.btts, clean_sheet: a.goals?.[o] === 0, scored: a.goals?.[side] > 0, conceded: a.goals?.[o] > 0,
        first_goal_minute: a.firstGoalMinute,
        corners_for: a.corners?.[side], corners_against: a.corners?.[o],
        shots_for: a.shots?.[side], shots_against: a.shots?.[o],
        sot_for: side === 'home' ? a.shots?.onTargetHome : a.shots?.onTargetAway, sot_against: o === 'home' ? a.shots?.onTargetHome : a.shots?.onTargetAway,
        fouls_for: a.fouls?.[side], fouls_against: a.fouls?.[o],
        offsides_for: a.offsides?.[side], offsides_against: a.offsides?.[o],
        possession: statVal(stArr, teamId, 'Ball Possession'),
        yellow_for: side === 'home' ? a.cards?.yellowHome : a.cards?.yellowAway, yellow_against: o === 'home' ? a.cards?.yellowHome : a.cards?.yellowAway,
        red_for: a.reds?.[side], red_against: a.reds?.[o],
        xg_for: statVal(stArr, teamId, 'expected_goals'), xg_against: statVal(stArr, oppId, 'expected_goals'),
        gf_1h: a.goals1H?.[side], gf_2h: a.goals2H?.[side], ga_1h: a.goals1H?.[o], ga_2h: a.goals2H?.[o],
        corners_1h: a.half?.firstHalf?.corners?.[side], corners_2h: a.half?.secondHalf?.corners?.[side],
        shots_1h: a.half?.firstHalf?.shots?.[side], shots_2h: a.half?.secondHalf?.shots?.[side],
        sot_1h: a.half?.firstHalf?.sot?.[side], sot_2h: a.half?.secondHalf?.sot?.[side],
        fouls_1h: a.half?.firstHalf?.fouls?.[side], fouls_2h: a.half?.secondHalf?.fouls?.[side],
        had_red_for: (a.reds?.[side] || 0) > 0, had_red_against: (a.reds?.[o] || 0) > 0, stats_present: statsPresent,
      };
    };
    const cols = Object.keys(mkTeam('home', homeId, awayId, true));
    // DO NOTHING defensivo (PK fixture+team): solo chocaría con home_id==away_id (dato corrupto); no aborta.
    await bulkInsert(c, 'model.team_match_stats', cols, [mkTeam('home', homeId, awayId, true), mkTeam('away', awayId, homeId, false)], 'ON CONFLICT DO NOTHING');
  }

  // player_match_stats (+ players dim)
  const pRows = [];
  for (const tb of plArr) {
    const teamId = tb.team?.id, oppId = teamId === homeId ? awayId : homeId, isHome = teamId === homeId;
    for (const p of (tb.players || [])) {
      const pid = p.player?.id; if (!pid) continue; const st = p.statistics?.[0] || {};
      await upsertOne(c, 'model.players', ['player_id', 'name', 'photo'], { player_id: pid, name: p.player?.name, photo: p.player?.photo }, 'player_id', ['name', 'photo']);
      pRows.push({ fixture_id: fid, player_id: pid, team_id: teamId, opponent_id: oppId, competition_id: lid, competition_category: cat, season, kickoff: fx.fixture?.date, is_home: isHome, phase: phaseOf(league.round),
        minutes: int(st.games?.minutes), position: st.games?.position, is_starter: st.games?.substitute === false, is_captain: st.games?.captain === true, is_substitute: st.games?.substitute === true, rating: num(st.games?.rating),
        goals: int(st.goals?.total) || 0, assists: int(st.goals?.assists) || 0, shots_total: int(st.shots?.total) || 0, shots_on: int(st.shots?.on) || 0,
        key_passes: int(st.passes?.key), passes_total: int(st.passes?.total), pass_accuracy: int(st.passes?.accuracy),
        tackles: int(st.tackles?.total), interceptions: int(st.tackles?.interceptions), blocks: int(st.tackles?.blocks), duels_total: int(st.duels?.total), duels_won: int(st.duels?.won),
        dribbles_attempts: int(st.dribbles?.attempts), dribbles_success: int(st.dribbles?.success), fouls_committed: int(st.fouls?.committed), fouls_drawn: int(st.fouls?.drawn),
        yellow: int(st.cards?.yellow) || 0, red: int(st.cards?.red) || 0, offsides: int(st.offsides),
        penalty_won: int(st.penalty?.won), penalty_committed: int(st.penalty?.commited ?? st.penalty?.committed), penalty_scored: int(st.penalty?.scored), penalty_missed: int(st.penalty?.missed), penalty_saved: int(st.penalty?.saved),
        saves: int(st.goals?.saves), goals_conceded: int(st.goals?.conceded) });
    }
  }
  // DO NOTHING defensivo (PK fixture+player): si la API listara al mismo jugador dos veces, no aborta.
  if (pRows.length) await bulkInsert(c, 'model.player_match_stats', Object.keys(pRows[0]), pRows, 'ON CONFLICT DO NOTHING');

  // match_events
  const eRows = evArr.map(e => ({ fixture_id: fid, minute: int(e.time?.elapsed), extra_minute: int(e.time?.extra), type: e.type, detail: e.detail, comments: e.comments, team_id: e.team?.id, player_id: e.player?.id, assist_player_id: e.assist?.id }));
  // ON CONFLICT DO NOTHING: la API a veces reporta DOS eventos con la misma clave
  // natural en el mismo fixture (p.ej. dos tarjetas al mismo jugador/minuto). Ignorar
  // el duplicado en vez de abortar la transacción (que dejaba el fixture sin ingerir).
  // Resuelve también duplicados ENTRE filas del mismo INSERT. DELETE previo = idempotencia.
  if (eRows.length) await bulkInsert(c, 'model.match_events', Object.keys(eRows[0]), eRows, 'ON CONFLICT DO NOTHING');

  // lineups (startXI + suplentes)
  const lRows = [];
  for (const tb of luArr) {
    const teamId = tb.team?.id, formation = tb.formation, coach = tb.coach?.id;
    for (const e of (tb.startXI || [])) if (e.player?.id) lRows.push({ fixture_id: fid, team_id: teamId, player_id: e.player.id, is_starter: true, position: e.player.pos, grid: e.player.grid, formation, coach_id: coach });
    for (const e of (tb.substitutes || [])) if (e.player?.id) lRows.push({ fixture_id: fid, team_id: teamId, player_id: e.player.id, is_starter: false, position: e.player.pos, grid: e.player.grid, formation, coach_id: coach });
  }
  // ON CONFLICT DO NOTHING: un jugador puede aparecer dos veces en la alineación del
  // crudo (startXI + substitutes, o repetido) → choca con lineups_pkey (fixtures
  // 1353602, 1362003). Ignorar el duplicado en vez de abortar el fixture entero.
  if (lRows.length) await bulkInsert(c, 'model.lineups', Object.keys(lRows[0]), lRows, 'ON CONFLICT DO NOTHING');

  // injuries (fx:)
  const iRows = injArr.map(j => ({ fixture_id: fid, team_id: j.team?.id, player_id: j.player?.id, season, type: j.player?.type, reason: j.player?.reason, report_date: fx.fixture?.date ? String(fx.fixture.date).slice(0, 10) : null })).filter(r => r.team_id && r.player_id);
  // Mismo riesgo: la API puede listar al mismo jugador/razón dos veces para el fixture
  // (misma clave ux_injuries_natural, report_date = fecha del partido) → DO NOTHING.
  if (iRows.length) await bulkInsert(c, 'model.match_injuries', Object.keys(iRows[0]), iRows, 'ON CONFLICT DO NOTHING');
}

// ── Carga batch de payloads relacionados (1 query por endpoint) ──
async function loadRelated(fids) {
  const m = {};
  for (const ep of ['fixtures/statistics', 'fixtures/events', 'fixtures/players', 'fixtures/lineups', 'fixtures/halfstats']) {
    const { rows } = await pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint=$1 AND ref_id = ANY($2::bigint[])`, [ep, fids]);
    m[ep] = new Map(rows.map(r => [Number(r.ref_id), r.payload]));
  }
  const { rows: inj } = await pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='injuries' AND sub_key LIKE 'fx:%' AND ref_id = ANY($1::bigint[])`, [fids]);
  m['injuries'] = new Map(inj.map(r => [Number(r.ref_id), r.payload]));
  return m;
}

(async () => {
  const teamFilter = ONLY_TEAM ? `AND (payload->'teams'->'home'->>'id'='${ONLY_TEAM}' OR payload->'teams'->'away'->>'id'='${ONLY_TEAM}')` : '';
  let last = 0;
  if (args.reset) await pool.query(`DELETE FROM model.ingest_checkpoint WHERE job='ingest_facts'`);
  if (args.resume) { const { rows } = await pool.query(`SELECT last_ref FROM model.ingest_checkpoint WHERE job='ingest_facts'`); last = Number(rows[0]?.last_ref || 0); }
  const { rows: [{ total }] } = await pool.query(`SELECT count(*)::bigint total FROM raw_api_payloads WHERE endpoint='fixtures' AND sub_key='' ${teamFilter}`);
  console.log(`[2B] fixtures a procesar: ${total} · batch=${BATCH} · resume desde ref_id>${last}${ONLY_TEAM ? ` · solo equipo ${ONLY_TEAM}` : ''}`);

  let done = 0, withStats = 0, withPlayers = 0;
  for (;;) {
    const { rows } = await pool.query(`SELECT ref_id, payload FROM raw_api_payloads WHERE endpoint='fixtures' AND sub_key='' AND ref_id>$1 ${teamFilter} ORDER BY ref_id LIMIT $2`, [last, BATCH]);
    if (!rows.length) break;
    const fids = rows.map(r => Number(r.ref_id));
    const rel = await loadRelated(fids);
    const client = await pool.connect();
    try {
      for (const r of rows) {
        const fx = r.payload; const fid = Number(r.ref_id);
        const relFx = { stats: rel['fixtures/statistics'].get(fid), events: rel['fixtures/events'].get(fid), players: rel['fixtures/players'].get(fid), lineups: rel['fixtures/lineups'].get(fid), halfstats: rel['fixtures/halfstats'].get(fid), injuries: rel['injuries'].get(fid) };
        await client.query('BEGIN');
        try { await processFixture(client, fx, relFx); await client.query('COMMIT'); }
        catch (e) { await client.query('ROLLBACK'); console.error(`  fixture ${fid} FALLÓ: ${e.message}`); }
        if (resp(relFx.stats).length) withStats++;
        if (resp(relFx.players).length) withPlayers++;
        done++; last = fid;
      }
    } finally { client.release(); }
    await pool.query(`INSERT INTO model.ingest_checkpoint (job,last_ref,processed,total,status,updated_at) VALUES ('ingest_facts',$1,$2,$3,'running',now()) ON CONFLICT (job) DO UPDATE SET last_ref=EXCLUDED.last_ref, processed=EXCLUDED.processed, total=EXCLUDED.total, status='running', updated_at=now()`, [last, done, total]);
    console.log(`  ${done}/${total} · conStats=${withStats} conPlayers=${withPlayers} · últimoFid=${last}`);
    if (LIMIT && done >= LIMIT) break;
  }
  await pool.query(`UPDATE model.ingest_checkpoint SET status='done', updated_at=now() WHERE job='ingest_facts'`);
  console.log(`[2B] FIN · procesados=${done} · conStats=${withStats} · conPlayers=${withPlayers}`);
  await pool.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
