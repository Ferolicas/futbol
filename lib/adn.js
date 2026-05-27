/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Cálculo PURO del ADN de equipo desde registros de partido (perspectiva del
// equipo). Lo usan: build-team-profiles (full, runtime), train-meta-models
// (point-in-time por muestra) y el runtime contextual. Una sola fuente de
// verdad → paridad train/score.
//
// CommonJS (require desde scripts node + import interop en Next).
// ────────────────────────────────────────────────────────────────────────

const RATE_METRICS = ['homeWinRate', 'homeLossRate', 'awayWinRate', 'awayLossRate', 'drawRate', 'bttsRate', 'over25Rate', 'scoredRate', 'cleanSheetRate'];
const AVG_METRICS = ['goalsForAvg', 'goalsAgainstAvg', 'cornersForAvg', 'cornersAgainstAvg', 'cardsForAvg', 'shotsForAvg', 'shotsAgainstAvg', 'sotForAvg', 'foulsForAvg'];
const ALL_METRICS = [...RATE_METRICS, ...AVG_METRICS];

const FINISHED = new Set(['FT', 'AET', 'PEN']);

// Lee un valor de la respuesta cruda de /fixtures/statistics.
function statVal(statsResp, teamId, type) {
  const arr = statsResp?.response || statsResp || [];
  const ts = (Array.isArray(arr) ? arr : []).find(s => s.team?.id === teamId);
  const v = (ts?.statistics || []).find(s => s.type === type)?.value;
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace('%', ''));
  return Number.isFinite(n) ? n : null;
}

// Clasifica el round → fase. Mismo criterio que feature-snapshot.
function phaseOf(round) {
  const r = String(round || '').toLowerCase();
  if (/\bfinal\b/.test(r) && !/semi|quarter|round of|1\/8/.test(r)) return 'final';
  if (/semi|quarter|round of 16|1\/8|knockout|eighth|playoff|play-off|elimination/.test(r)) return 'knockout';
  if (/group/.test(r)) return 'group';
  return 'regular';
}

// Construye el registro point-in-time-able de UN partido desde el crudo, en la
// perspectiva de `teamId`. fixtureObj = payload de raw 'fixtures'; statsResp =
// payload de raw 'fixtures/statistics' (o null). Devuelve null si no aplica.
function recordFromRaw(fixtureObj, statsResp, teamId) {
  const f = fixtureObj || {};
  const homeId = f.teams?.home?.id, awayId = f.teams?.away?.id;
  if (teamId !== homeId && teamId !== awayId) return null;
  if (!FINISHED.has(f.fixture?.status?.short)) return null;
  const isHome = teamId === homeId;
  // FT (90 min) cuando exista score.fulltime; si no, goals.
  const ftH = f.score?.fulltime?.home ?? f.goals?.home;
  const ftA = f.score?.fulltime?.away ?? f.goals?.away;
  if (ftH == null || ftA == null) return null;
  const gf = isHome ? ftH : ftA, ga = isHome ? ftA : ftH;
  const me = teamId, opp = isHome ? awayId : homeId;
  const yc = statVal(statsResp, me, 'Yellow Cards') || 0;
  const rc = statVal(statsResp, me, 'Red Cards') || 0;
  return {
    fixtureId: f.fixture?.id,
    date: f.fixture?.date,
    leagueId: f.league?.id,
    round: f.league?.round,
    phase: phaseOf(f.league?.round),
    venue: isHome ? 'home' : 'away',
    opponentId: opp,
    result: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
    gf, ga,
    btts: gf > 0 && ga > 0,
    total: gf + ga,
    cornersFor: statVal(statsResp, me, 'Corner Kicks'),
    cornersAgainst: statVal(statsResp, opp, 'Corner Kicks'),
    cards: yc + rc,
    shotsFor: statVal(statsResp, me, 'Total Shots'),
    shotsAgainst: statVal(statsResp, opp, 'Total Shots'),
    sot: statVal(statsResp, me, 'Shots on Goal'),
    fouls: statVal(statsResp, me, 'Fouls'),
    possession: statVal(statsResp, me, 'Ball Possession'),
    xgFor: statVal(statsResp, me, 'expected_goals'),
    xgAgainst: statVal(statsResp, opp, 'expected_goals'),
  };
}

const avg = (xs) => { const v = xs.filter(x => x != null && isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const rate = (xs) => { const v = xs.filter(x => x != null); return v.length ? v.filter(Boolean).length / v.length : null; };

// Calcula las 18 métricas {emp, n} desde un array de registros (perspectiva equipo).
function computeMetrics(records) {
  const home = records.filter(r => r.venue === 'home');
  const away = records.filter(r => r.venue === 'away');
  const out = {};
  const put = (k, v, n) => { if (v != null && n > 0) out[k] = { emp: v, n }; };

  put('homeWinRate',  rate(home.map(r => r.result === 'W')), home.length);
  put('homeLossRate', rate(home.map(r => r.result === 'L')), home.length);
  put('awayWinRate',  rate(away.map(r => r.result === 'W')), away.length);
  put('awayLossRate', rate(away.map(r => r.result === 'L')), away.length);
  put('drawRate',     rate(records.map(r => r.result === 'D')), records.length);
  put('bttsRate',     rate(records.map(r => r.btts)), records.length);
  put('over25Rate',   rate(records.map(r => r.total > 2.5)), records.length);
  put('scoredRate',   rate(records.map(r => r.gf > 0)), records.length);
  put('cleanSheetRate', rate(records.map(r => r.ga === 0)), records.length);

  const withN = (key, vals) => { const v = vals.filter(x => x != null); put(key, avg(v), v.length); };
  withN('goalsForAvg',     records.map(r => r.gf));
  withN('goalsAgainstAvg', records.map(r => r.ga));
  withN('cornersForAvg',     records.map(r => r.cornersFor));
  withN('cornersAgainstAvg', records.map(r => r.cornersAgainst));
  withN('cardsForAvg',       records.map(r => r.cards));
  withN('shotsForAvg',       records.map(r => r.shotsFor));
  withN('shotsAgainstAvg',   records.map(r => r.shotsAgainst));
  withN('sotForAvg',         records.map(r => r.sot));
  withN('foulsForAvg',       records.map(r => r.fouls));
  return out;
}

// Shrinkage bayesiano hacia un prior (de liga). k = fuerza del prior.
function shrink(emp, n, prior, k) {
  if (prior == null) return emp;
  if (emp == null) return prior;
  return (n * emp + k * prior) / (n + k);
}

// Filtra registros por segmento.
function filterSegment(records, segment) {
  if (segment === 'all') return records;
  if (segment === 'home') return records.filter(r => r.venue === 'home');
  if (segment === 'away') return records.filter(r => r.venue === 'away');
  if (segment.startsWith('comp:')) { const lid = Number(segment.slice(5)); return records.filter(r => r.leagueId === lid); }
  if (segment.startsWith('phase:')) { const p = segment.slice(6); return records.filter(r => r.phase === p); }
  return records;
}

module.exports = { RATE_METRICS, AVG_METRICS, ALL_METRICS, FINISHED, statVal, phaseOf, recordFromRaw, computeMetrics, shrink, filterSegment, avg, rate };
