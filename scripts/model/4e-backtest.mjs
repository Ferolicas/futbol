// scripts/model/4e-backtest.mjs
// FASE 4E — backtest de fiabilidad del motor model-engine. SOLO LECTURA (no escribe BD,
// no modifica el motor). Mide si las probabilidades calibran contra resultados reales,
// POINT-IN-TIME (cutoff = kickoff de cada fixture; anti-fuga, igual que el probe --pit).
//
//   node --env-file=.env.local scripts/model/4e-backtest.mjs --limit=200
//   node --env-file=.env.local scripts/model/4e-backtest.mjs --liga=39 --season=2023
//   node --env-file=.env.local scripts/model/4e-backtest.mjs --variant=nucleo    (tabla de buckets: nucleo|h2h)
//   node --env-file=.env.local scripts/model/4e-backtest.mjs --resume             (reanuda checkpoint)
//   flags: --limit N · --liga ID · --season YYYY · --batch N (progreso/checkpoint) · --variant · --fresh
//
// Universo: fixtures finalizados (result + ft no nulos) donde AMBOS equipos cumplen el veto
// de producción (≥5 finalizados antes del cutoff). 2 variantes LIMPIAS por fixture: nucleo
// y h2h. Diagrama de fiabilidad (buckets finos arriba) + ECE + Brier por (familia × variante)
// y (cobertura × variante). Lento; usar --limit para validar primero.
//
// FUGA CONOCIDA — variantes con JUGADOR pendientes: model.player_impact se construyó sobre
// TODO el histórico (sin cutoff), así que sus deltas incluyen partidos POSTERIORES al fixture
// que se predice → fuga de futuro. Por eso aquí NO se corren "jugador"/"completo" ni se llama
// fetchPlayerContext/applyPlayer (el cutoff de filas/H2H/ranks SÍ es correcto; el agujero es
// solo esa tabla pre-agregada). Pendiente: sub-fase que recalcule player_impact point-in-time
// (cutoff por fixture) para poder medir esas variantes sin fuga.
import fs from 'fs';
import pg from 'pg';
import { computeBaseMarkets, fetchH2HRows, applyH2H } from '../../lib/model-engine.js';

const args = Object.fromEntries(process.argv.slice(2).map(s => { const m = s.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] === '' ? true : m[2]] : [s, true]; }));
const LIMIT = args.limit ? Number(args.limit) : null;
const LIGA = args.liga ? Number(args.liga) : null;
const SEASON = args.season ? Number(args.season) : null;
const BATCH = args.batch ? Number(args.batch) : 100;
const VARIANT_TABLE = args.variant || 'h2h';        // variante para la tabla de buckets
const CKPT = 'scripts/model/.4e-checkpoint.json';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 3 });

const MIN_HISTORY = 5;                                // veto de producción: ≥5 finalizados por equipo
const VARIANTS = ['nucleo', 'h2h'];   // jugador/completo OMITIDAS: fuga en player_impact (ver header), pendientes
// buckets: gruesos abajo, FINOS arriba (zona alta es la que importa para apostar)
const EDGES = [0, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.85, 0.90, 0.95, 1.0001];
const BLABEL = ['0-10', '10-20', '20-30', '30-40', '40-50', '50-60', '60-70', '70-80', '80-85', '85-90', '90-95', '95-100'];
const COV_HI = 300, COV_LO = 60;                      // cobertura de liga por nº de fixtures en el set (ajustable)

const num = (x) => (x == null ? null : Number(x));
const add = (a, b) => (a == null || b == null ? null : Number(a) + Number(b));
const cardsOne = (y, r) => (y == null ? null : Number(y) + (r == null ? 0 : Number(r)));
const cardsTot = (y1, r1, y2, r2) => (y1 == null || y2 == null ? null : Number(y1) + (r1 ? Number(r1) : 0) + Number(y2) + (r2 ? Number(r2) : 0));
const clone = (m) => JSON.parse(JSON.stringify(m));
const pct = (x) => (x == null ? '  —  ' : `${(x * 100).toFixed(1)}%`);
const bucketIdx = (p) => { for (let i = 0; i < BLABEL.length; i++) if (p >= EDGES[i] && p < EDGES[i + 1]) return i; return -1; };

// ── (1c) RESULTADO REAL por familia, del row de hechos del LOCAL (perspectiva home) ──
// OU: total = for+against; home = for; away = against (= goles/córners/etc. del visitante).
const OU_ACTUAL = {
  goals:    { total: r => add(r.ft_home, r.ft_away), home: r => num(r.ft_home), away: r => num(r.ft_away) },
  corners:  { total: r => add(r.corners_for, r.corners_against), home: r => num(r.corners_for), away: r => num(r.corners_against) },
  cards:    { total: r => cardsTot(r.yellow_for, r.red_for, r.yellow_against, r.red_against), home: r => cardsOne(r.yellow_for, r.red_for), away: r => cardsOne(r.yellow_against, r.red_against) },
  shots:    { total: r => add(r.shots_for, r.shots_against), home: r => num(r.shots_for), away: r => num(r.shots_against) },
  sot:      { total: r => add(r.sot_for, r.sot_against), home: r => num(r.sot_for), away: r => num(r.sot_against) },
  fouls:    { total: r => add(r.fouls_for, r.fouls_against), home: r => num(r.fouls_for), away: r => num(r.fouls_against) },
  offsides: { total: r => add(r.offsides_for, r.offsides_against), home: r => num(r.offsides_for), away: r => num(r.offsides_against) },
};
const BOOL_ACTUAL = {
  btts: r => (r.ft_home > 0 && r.ft_away > 0 ? 1 : 0),
  clean_sheet_home: r => (r.ft_away === 0 ? 1 : 0),   // local deja valla a cero ⇔ visitante marcó 0
  clean_sheet_away: r => (r.ft_home === 0 ? 1 : 0),
};
const RESULT_HIT = { home: r => (r.result === 'H' ? 1 : 0), draw: r => (r.result === 'D' ? 1 : 0), away: r => (r.result === 'A' ? 1 : 0) };

// ── (2) ACUMULADORES + ECE/Brier ────────────────────────────────────────────
// acc[scope]["variant|key"] = { b: [{sp,sh,n}×12], bs, bn }   (sp=Σprob, sh=Σhit, bs=ΣBrier, bn)
const acc = { fam: {}, tier: {} };
function entry(scope, k) {
  if (!acc[scope][k]) acc[scope][k] = { b: EDGES.slice(0, -1).map(() => ({ sp: 0, sh: 0, n: 0 })), bs: 0, bn: 0 };
  return acc[scope][k];
}
function record(variant, family, tier, prob, hit) {
  if (prob == null || hit == null) return;
  const i = bucketIdx(prob); if (i < 0) return;
  for (const [scope, key] of [['fam', `${variant}|${family}`], ['tier', `${variant}|${tier}`]]) {
    const e = entry(scope, key); const bk = e.b[i];
    bk.sp += prob; bk.sh += hit; bk.n++; e.bs += (prob - hit) ** 2; e.bn++;
  }
}
const eceOf = (e) => { let N = 0, s = 0; for (const bk of e.b) { N += bk.n; s += Math.abs(bk.sp - bk.sh); } return N ? s / N : null; };  // Σ|Σp−Σh| / N
const brierOf = (e) => (e.bn ? e.bs / e.bn : null);
const totalN = (e) => e.b.reduce((s, bk) => s + bk.n, 0);

// puntúa todos los mercados de una variante contra el resultado real (row).
function score(variant, markets, row, tier) {
  for (const key of Object.keys(markets)) {
    const mk = markets[key]; if (!mk) continue;
    if (key === '1x2') {
      for (const o of ['home', 'draw', 'away']) record(variant, '1x2', tier, mk[o], RESULT_HIT[o](row));
    } else if (BOOL_ACTUAL[key]) {
      record(variant, key, tier, mk.prob, BOOL_ACTUAL[key](row));
    } else if (mk.kind === 'ou') {
      const us = key.lastIndexOf('_'), fam = key.slice(0, us), scope = key.slice(us + 1);
      const ext = OU_ACTUAL[fam] && OU_ACTUAL[fam][scope]; if (!ext) continue;
      const actual = ext(row); if (actual == null) continue;          // sin dato real de esa familia → no se puntúa
      for (const ln of mk.lines) record(variant, key, tier, ln.prob, actual > ln.line ? 1 : 0);
    }
  }
}

(async () => {
  // ── (1a) UNIVERSO: finalizados con resultado + hechos del local; orden por kickoff (determinista) ──
  const where = ['m.result IS NOT NULL', 'm.ft_home IS NOT NULL', 'm.ft_away IS NOT NULL'];
  const params = [];
  if (LIGA) { params.push(LIGA); where.push(`m.competition_id = $${params.length}`); }
  if (SEASON) { params.push(SEASON); where.push(`m.season = $${params.length}`); }
  const { rows: U } = await pool.query(
    `SELECT m.fixture_id, m.home_team_id, m.away_team_id, m.competition_id, m.season, m.phase, m.kickoff,
            m.home_rank_before, m.away_rank_before, cs.n_teams, m.ft_home, m.ft_away, m.result,
            t.corners_for, t.corners_against, t.shots_for, t.shots_against, t.sot_for, t.sot_against,
            t.fouls_for, t.fouls_against, t.offsides_for, t.offsides_against,
            t.yellow_for, t.yellow_against, t.red_for, t.red_against
     FROM model.matches m
     JOIN model.team_match_stats t ON t.fixture_id = m.fixture_id AND t.team_id = m.home_team_id
     LEFT JOIN model.competition_seasons cs ON cs.competition_id = m.competition_id AND cs.season = m.season
     WHERE ${where.join(' AND ')}
     ORDER BY m.kickoff ASC ${LIMIT ? `LIMIT ${LIMIT}` : ''}`, params);

  // ── (1b) cobertura por liga = nº de fixtures de esa competición en el set ──
  const compCount = {}; for (const r of U) compCount[r.competition_id] = (compCount[r.competition_id] || 0) + 1;
  const tierOf = (cid) => { const c = compCount[cid] || 0; return c >= COV_HI ? 'alta' : c >= COV_LO ? 'media' : 'baja'; };

  // reanudación opcional (checkpoint local)
  let startIdx = 0;
  const filterKey = `${LIGA || '*'}:${SEASON || '*'}:${LIMIT || '*'}`;
  if (args.resume && !args.fresh && fs.existsSync(CKPT)) {
    const ck = JSON.parse(fs.readFileSync(CKPT, 'utf8'));
    if (ck.filterKey === filterKey) { Object.assign(acc, ck.acc); startIdx = ck.idx; console.log(`[4E] reanudando desde fixture #${startIdx}/${U.length}`); }
  }

  console.log(`[4E] universo: ${U.length} fixtures finalizados${LIGA ? ` liga=${LIGA}` : ''}${SEASON ? ` season=${SEASON}` : ''} · veto≥${MIN_HISTORY} · point-in-time`);
  const t0 = Date.now(); let done = 0, vetoed = 0, errs = 0;

  for (let idx = startIdx; idx < U.length; idx++) {
    const r = U[idx];
    const ctx = {
      homeTeamId: Number(r.home_team_id), awayTeamId: Number(r.away_team_id),
      competitionId: Number(r.competition_id), season: r.season != null ? Number(r.season) : null,
      phase: r.phase, nTeams: r.n_teams != null ? Number(r.n_teams) : null,
      homeRank: r.home_rank_before != null ? Number(r.home_rank_before) : null,   // point-in-time
      awayRank: r.away_rank_before != null ? Number(r.away_rank_before) : null,
      cutoff: new Date(r.kickoff),
    };
    try {
      // cache FRESCA por fixture: el base-rate liga/global es point-in-time (cutoff distinto c/u)
      const base = await computeBaseMarkets(pool, ctx, { cache: new Map() });
      if (base.fixture.homeRows < MIN_HISTORY || base.fixture.awayRows < MIN_HISTORY) { vetoed++; continue; } // mismo veto de prod
      const h2hRows = await fetchH2HRows(pool, ctx.homeTeamId, ctx.awayTeamId, ctx.cutoff);
      const tier = tierOf(r.competition_id);
      // ── (3) variantes LIMPIAS sobre copias del núcleo (las capas mutan in-place) ──
      // jugador/completo OMITIDAS: player_impact tiene fuga (deltas sin cutoff) — ver header.
      score('nucleo', clone(base.markets), r, tier);
      score('h2h', applyH2H(clone(base.markets), h2hRows, ctx), r, tier);
      done++;
    } catch (e) { errs++; if (errs <= 5) console.error(`  err fixture ${r.fixture_id}: ${e.message}`); }

    if ((idx + 1) % BATCH === 0 || idx === U.length - 1) {
      const el = (Date.now() - t0) / 1000, rate = (idx + 1 - startIdx) / el, eta = (U.length - idx - 1) / rate;
      const ov = acc.fam[`h2h|goals_total`];
      console.log(`[4E] ${idx + 1}/${U.length} · ok=${done} veto=${vetoed} err=${errs} · ${el.toFixed(0)}s (${rate.toFixed(1)}/s, ETA ${eta.toFixed(0)}s) · ECE h2h|goals_total=${eceOf(ov) != null ? (eceOf(ov) * 100).toFixed(2) + '%' : '—'}`);
      try { fs.writeFileSync(CKPT, JSON.stringify({ filterKey, idx: idx + 1, acc })); } catch {}
    }
  }
  console.log(`[4E] FIN · procesados=${done} vetados=${vetoed} errores=${errs} · ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
  printTables();
  await pool.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });

// ── tablas de salida ──────────────────────────────────────────────────────
function printTables() {
  const families = [...new Set(Object.keys(acc.fam).map(k => k.split('|')[1]))].sort();
  // A) ECE + Brier por (familia × variante)
  console.log('═══ A) ECE / Brier por familia × variante (ECE menor = mejor calibrado) ═══');
  console.log(['familia'.padEnd(18), ...VARIANTS.map(v => v.padEnd(16))].join(''));
  for (const fam of families) {
    const cells = VARIANTS.map(v => { const e = acc.fam[`${v}|${fam}`]; if (!e) return ''.padEnd(16); const ece = eceOf(e), br = brierOf(e); return `${(ece * 100).toFixed(1)}%/${br.toFixed(3)}`.padEnd(16); });
    const nrep = totalN(acc.fam[`h2h|${fam}`] || { b: [] });
    console.log([`${fam}`.padEnd(18), ...cells].join('') + `  (n=${nrep})`);
  }
  // B) fiabilidad por (familia × bucket) para la variante elegida
  console.log(`\n═══ B) Fiabilidad por familia × bucket — variante=${VARIANT_TABLE} (pred vs real; gap=|pred−real|) ═══`);
  for (const fam of families) {
    const e = acc.fam[`${VARIANT_TABLE}|${fam}`]; if (!e || totalN(e) === 0) continue;
    console.log(`· ${fam} (n=${totalN(e)})`);
    for (let i = 0; i < BLABEL.length; i++) { const bk = e.b[i]; if (bk.n === 0) continue;
      const pred = bk.sp / bk.n, real = bk.sh / bk.n;
      console.log(`    ${BLABEL[i].padEnd(7)} pred ${pct(pred)}  real ${pct(real)}  gap ${(Math.abs(pred - real) * 100).toFixed(1)}%  n=${bk.n}`);
    }
  }
  // C) ECE por (cobertura × variante)
  console.log('\n═══ C) ECE por cobertura de liga × variante ═══');
  console.log(['cobertura'.padEnd(12), ...VARIANTS.map(v => v.padEnd(14))].join(''));
  for (const tier of ['alta', 'media', 'baja']) {
    const cells = VARIANTS.map(v => { const e = acc.tier[`${v}|${tier}`]; if (!e) return ''.padEnd(14); return `${(eceOf(e) * 100).toFixed(1)}% (${totalN(e)})`.padEnd(14); });
    console.log([`${tier}`.padEnd(12), ...cells].join(''));
  }
  console.log(`\nCobertura: alta ≥${COV_HI} fixtures/liga · media ≥${COV_LO} · baja <${COV_LO} (en el set).`);
}
