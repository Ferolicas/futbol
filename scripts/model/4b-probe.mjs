// scripts/model/4b-probe.mjs
// FASE 4B/4C — sonda del motor: imprime la escalera de probabilidades de un fixture
// (núcleo de conteo 4B + capa H2H 4C-1). Función pura, sin escrituras.
//   node --env-file=.env.local scripts/model/4b-probe.mjs --fixture=1234567
//   node --env-file=.env.local scripts/model/4b-probe.mjs --fixture=1234567 --pit
//     --pit = point-in-time (cutoff = kickoff del partido, ranks = rank_before).
//             Sin --pit = serving (cutoff = ahora, rank oficial→before como fallback).
//   --json  imprime el objeto completo (con la cadena de pooling auditable).
import pg from 'pg';
import { computeBaseMarkets, fetchH2HRows, applyH2H, fetchPlayerContext, applyPlayer, computePlayerShifts } from '../../lib/model-engine.js';

const args = Object.fromEntries(process.argv.slice(2).map(s => { const m = s.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] === '' ? true : m[2]] : [s, true]; }));
const fixtureId = Number(args.fixture);
if (!fixtureId) { console.error('Falta --fixture=<id>'); process.exit(1); }
const pit = !!args.pit;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 3 });

(async () => {
  const { rows } = await pool.query(
    `SELECT m.home_team_id, m.away_team_id, m.competition_id, m.season, m.phase, m.kickoff,
            th.name AS home_name, ta.name AS away_name, c.name AS comp_name, cs.n_teams,
            COALESCE(m.home_rank_official, m.home_rank_before) AS home_rank_srv,
            COALESCE(m.away_rank_official, m.away_rank_before) AS away_rank_srv,
            m.home_rank_before, m.away_rank_before
     FROM model.matches m
     LEFT JOIN model.teams th ON th.team_id = m.home_team_id
     LEFT JOIN model.teams ta ON ta.team_id = m.away_team_id
     LEFT JOIN model.competitions c ON c.competition_id = m.competition_id
     LEFT JOIN model.competition_seasons cs ON cs.competition_id = m.competition_id AND cs.season = m.season
     WHERE m.fixture_id = $1`, [fixtureId]);
  if (!rows.length) { console.error(`fixture ${fixtureId} no está en model.matches`); process.exit(1); }
  const m = rows[0];

  const ctx = {
    homeTeamId: Number(m.home_team_id), awayTeamId: Number(m.away_team_id),
    competitionId: Number(m.competition_id), season: m.season != null ? Number(m.season) : null,
    phase: m.phase, nTeams: m.n_teams != null ? Number(m.n_teams) : null,
    homeRank: pit ? (m.home_rank_before != null ? Number(m.home_rank_before) : null) : (m.home_rank_srv != null ? Number(m.home_rank_srv) : null),
    awayRank: pit ? (m.away_rank_before != null ? Number(m.away_rank_before) : null) : (m.away_rank_srv != null ? Number(m.away_rank_srv) : null),
    cutoff: pit ? new Date(m.kickoff) : new Date(),
  };

  const t0 = Date.now();
  const res = await computeBaseMarkets(pool, ctx);
  const h2hRows = await fetchH2HRows(pool, ctx.homeTeamId, ctx.awayTeamId, ctx.cutoff);
  applyH2H(res.markets, h2hRows, ctx);            // capa H2H (muta res.markets in-place)
  const pctx = await fetchPlayerContext(pool, fixtureId, ctx);
  const ps = computePlayerShifts(pctx, ctx);
  applyPlayer(res.markets, pctx, ctx);            // capa de jugador (muta res.markets in-place)
  const ms = Date.now() - t0;
  const nCur = h2hRows.filter(r => Number(r.comp_id) === Number(ctx.competitionId) && Number(r.comp_season) === Number(ctx.season)).length;
  const nHist = h2hRows.length - nCur;

  if (args.json) { console.log(JSON.stringify({ ...res, h2h: { total: h2hRows.length, cur: nCur, hist: nHist }, player: ps }, null, 2)); await pool.end(); return; }

  const f = res.fixture;
  console.log(`\n${m.home_name} vs ${m.away_name}  ·  ${m.comp_name} ${ctx.season ?? ''}  ·  fixture ${fixtureId}`);
  console.log(`modo=${pit ? 'POINT-IN-TIME' : 'serving'}  cutoff=${f.cutoff}  phase=${f.phase}${f.isKnockout ? '(KO)' : ''}`);
  console.log(`rank hoy: local=${f.homeRank ?? '—'} visita=${f.awayRank ?? '—'}  nTeams=${f.nTeams ?? '—'}  ·  filas: local=${f.homeRows} visita=${f.awayRows} liga=${f.leagueRows}  ·  ${ms}ms`);
  console.log(`H2H directos (H vs A): total=${h2hRows.length}  ·  actual modo(a)=${nCur}  ·  histórico modo(b)=${nHist}  ·  1X2 mode=${process.env.H2H_1X2_MODE || 'softweight'}`);
  console.log(`Jugador: lineup=${ps.hasLineup ? 'sí' : 'no'}  ·  local shift_gf=${ps.home.shift_gf} shift_ga=${ps.home.shift_ga} ausentes=${ps.home.ausentes.length}  ·  visita shift_gf=${ps.away.shift_gf} shift_ga=${ps.away.shift_ga} ausentes=${ps.away.ausentes.length}\n`);

  const r1x2 = res.markets['1x2'];
  if (r1x2) console.log(`1X2   local ${pct(r1x2.home)}  empate ${pct(r1x2.draw)}  visita ${pct(r1x2.away)}   (n=${r1x2.n} conf=${r1x2.conf})\n`);

  const order = [];
  for (const fam of ['goals', 'corners', 'cards', 'shots', 'sot', 'fouls', 'offsides']) for (const sc of ['total', 'home', 'away']) order.push(`${fam}_${sc}`);
  for (const key of order) {
    const mk = res.markets[key]; if (!mk) continue;
    const cells = mk.lines.map(l => `o${l.line}:${pct(l.prob)}[${l.level}/n${l.n}]`).join('  ');
    console.log(`${key.padEnd(15)} ${cells}`);
  }
  for (const key of ['btts', 'clean_sheet_home', 'clean_sheet_away']) {
    const mk = res.markets[key]; if (!mk) continue;
    console.log(`${key.padEnd(15)} ${pct(mk.prob)} [${mk.level}/n${mk.n} conf=${mk.conf}]`);
  }

  if (nCur > 0 || nHist > 0) {
    console.log('\n— H2H aplicado (antes → después) —');
    const stx = (res.markets['1x2'].chain || []).filter(c => c.step === 'h2h');
    for (const s of stx) console.log(`  1x2 modo(${s.mode}) n=${s.n}: ${trip(s.before)} → ${trip(s.after)}`);
    const gt = res.markets['goals_total'];
    if (gt) for (const ln of gt.lines) {
      const st = (ln.chain || []).filter(c => c.step === 'h2h');
      if (st.length) console.log(`  goals_total o${ln.line}: ${pct(st[0].before)} → ${pct(st[st.length - 1].after)} (${st.map(x => `${x.mode}:n${x.n}`).join(', ')})`);
    }
  }

  if (ps.hasLineup && (ps.home.ausentes.length || ps.away.ausentes.length)) {
    console.log('\n— Jugador aplicado (antes → después) —');
    console.log(`  shift local gf=${ps.home.shift_gf} ga=${ps.home.shift_ga} ausentes=[${ps.home.ausentes.join(',')}]  ·  visita gf=${ps.away.shift_gf} ga=${ps.away.shift_ga} ausentes=[${ps.away.ausentes.join(',')}]`);
    for (const s of (res.markets['1x2'].chain || []).filter(c => c.step === 'player')) console.log(`  1x2: ${trip(s.before)} → ${trip(s.after)} (n=${s.n})`);
    const gtp = res.markets['goals_total'];
    if (gtp) for (const ln of gtp.lines) {
      const st = (ln.chain || []).filter(c => c.step === 'player');
      if (st.length) console.log(`  goals_total o${ln.line}: ${pct(st[0].before)} → ${pct(st[st.length - 1].after)} (n=${st[0].n})`);
    }
  }
  console.log('');
  await pool.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });

function pct(p) { return p == null ? ' — ' : `${(p * 100).toFixed(1)}%`; }
function trip(t) { return `${Math.round(t.home * 100)}/${Math.round(t.draw * 100)}/${Math.round(t.away * 100)}`; }
