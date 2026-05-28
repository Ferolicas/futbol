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

// ──────────────────────────────────────────────────────────────────────────
// buildActuals — objeto canónico "qué pasó en el partido" en perspectiva
// HOME/AWAY del propio fixture. Es la ÚNICA definición de los hechos de un
// partido: la usan H2H (meetingRecord/orient vía flipActuals) y el ADN
// por-línea, de modo que MARKET_DEFS[m].outcome/gate da EXACTAMENTE el mismo
// resultado por ambas vías → paridad total.
//
//   fixtureObj : payload raw 'fixtures' (objeto fixture completo de API-Football)
//   statsResp  : payload raw 'fixtures/statistics' (o null)
//   eventsResp : payload raw 'fixtures/events' (o null) — minutos de gol/tarjeta
//   halfStats  : payload de 'fixtures/halfstats' (o null) — split de stats sin minuto
// Devuelve null si el partido no está finalizado o falta el marcador FT.
function buildActuals(fixtureObj, statsResp, eventsResp, halfStats) {
  const f = fixtureObj || {};
  const homeId = f.teams?.home?.id, awayId = f.teams?.away?.id;
  if (!homeId || !awayId) return null;
  if (!FINISHED.has(f.fixture?.status?.short)) return null;
  // FT (90 min) — las casas pagan a 90'; AET solo informativo.
  const ftH = f.score?.fulltime?.home ?? f.goals?.home;
  const ftA = f.score?.fulltime?.away ?? f.goals?.away;
  if (ftH == null || ftA == null) return null;

  const sum = (a, b) => (a == null || b == null) ? null : a + b;
  const sv = (tid, type) => statVal(statsResp, tid, type);
  const res = (h, a) => h > a ? 'H' : h < a ? 'A' : 'D';

  // Lectura de CONTADOR con denominador correcto: si el bloque de statistics del
  // equipo está PRESENTE, una stat ausente/null cuenta como 0 (el evento no
  // ocurrió → el partido es muestra VÁLIDA). Solo es null si el equipo no tiene
  // statistics en este partido (dato genuinamente inexistente → se excluye).
  // Arregla el sesgo de denominador en mercados de baja frecuencia: API-Football
  // OMITE "Red Cards"/"Offsides" en muchos partidos sin el evento, y antes eso
  // los excluía → red_card_any salía 100% sobre solo los partidos con roja.
  const teamHasStats = (tid) => {
    const arr = statsResp?.response || statsResp || [];
    const t = (Array.isArray(arr) ? arr : []).find(s => s.team?.id === tid);
    return !!(t && Array.isArray(t.statistics) && t.statistics.length);
  };
  const cnt = (tid, type) => { const v = sv(tid, type); return v != null ? v : (teamHasStats(tid) ? 0 : null); };

  // Goles por mitad: score.halftime = 1ª parte (a 90'); 2ª = FT − 1ª.
  const htH = f.score?.halftime?.home, htA = f.score?.halftime?.away;
  const has1H = htH != null && htA != null;
  const goals1H = has1H ? { home: htH, away: htA, total: htH + htA } : null;
  const goals2H = has1H ? { home: ftH - htH, away: ftA - htA, total: (ftH - htH) + (ftA - htA) } : null;

  // Eventos: minutos de gol (timing) y tarjetas por mitad.
  const evArr = (() => { const e = eventsResp?.response ?? eventsResp; return Array.isArray(e) ? e : []; })();
  const minOf = (e) => (e?.time?.elapsed != null ? e.time.elapsed + (e.time.extra || 0) : null);
  const goalEv = evArr.filter(e => e?.type === 'Goal' && e?.detail !== 'Missed Penalty');
  const cardEv = evArr.filter(e => e?.type === 'Card');
  const goalEventsLite = goalEv.map(e => ({ teamId: e.team?.id ?? null, minute: minOf(e), detail: e.detail || null }))
                               .filter(g => g.minute != null);
  const goalMinutes = goalEventsLite.map(g => g.minute).sort((a, b) => a - b);
  const firstGoalMinute = goalMinutes.length ? goalMinutes[0] : null;

  // Tarjetas totales por equipo (de stats; fallback a contar eventos). cnt →
  // amarilla/roja omitida con stats presentes = 0 (no excluye el partido).
  const yh = cnt(homeId, 'Yellow Cards'), ya = cnt(awayId, 'Yellow Cards');
  const rh = cnt(homeId, 'Red Cards'),    ra = cnt(awayId, 'Red Cards');
  const haveCardStats = [yh, ya, rh, ra].some(v => v != null);
  const cardHome = haveCardStats ? (yh || 0) + (rh || 0) : (cardEv.length ? cardEv.filter(e => e.team?.id === homeId).length : null);
  const cardAway = haveCardStats ? (ya || 0) + (ra || 0) : (cardEv.length ? cardEv.filter(e => e.team?.id === awayId).length : null);

  // Tarjetas por mitad (desde eventos con minuto; null si no hay eventos).
  let cardsByHalf = null;
  if (cardEv.length) {
    const inFirst = (e) => (minOf(e) ?? 99) <= 45;
    const h1 = cardEv.filter(e => e.team?.id === homeId && inFirst(e)).length;
    const a1 = cardEv.filter(e => e.team?.id === awayId && inFirst(e)).length;
    const hT = cardEv.filter(e => e.team?.id === homeId).length;
    const aT = cardEv.filter(e => e.team?.id === awayId).length;
    cardsByHalf = {
      firstHalf:  { home: h1, away: a1, total: h1 + a1 },
      secondHalf: { home: hT - h1, away: aT - a1, total: (hT - h1) + (aT - a1) },
    };
  }

  // Stats agregadas a 90' (full match). cnt → contador omitido con stats
  // presentes = 0 (offsides es el caso típico que la API omite sin el evento).
  const cH = cnt(homeId, 'Corner Kicks'), cA = cnt(awayId, 'Corner Kicks');
  const shH = cnt(homeId, 'Total Shots'), shA = cnt(awayId, 'Total Shots');
  const soH = cnt(homeId, 'Shots on Goal'), soA = cnt(awayId, 'Shots on Goal');
  const flH = cnt(homeId, 'Fouls'), flA = cnt(awayId, 'Fouls');
  const oH = cnt(homeId, 'Offsides'), oA = cnt(awayId, 'Offsides');

  // Split por mitad de stats sin minuto (córners/tiros/faltas/offsides) desde
  // el snapshot HT durable (fixtures/halfstats). null si aún no se capturó.
  const hs = halfStats?.payload ?? halfStats ?? null;
  const half = (hs && (hs.firstHalf || hs.secondHalf)) ? {
    firstHalf:  hs.firstHalf  || null,
    secondHalf: hs.secondHalf || null,
  } : null;

  return {
    status: f.fixture?.status?.short ?? null,
    leagueId: f.league?.id ?? null,
    round: f.league?.round ?? null,
    phase: phaseOf(f.league?.round),
    homeId, awayId,
    result: res(ftH, ftA),
    goals: { home: ftH, away: ftA, total: ftH + ftA, btts: ftH > 0 && ftA > 0 },
    goals1H, goals2H,
    result1H: goals1H ? res(goals1H.home, goals1H.away) : null,
    result2H: goals2H ? res(goals2H.home, goals2H.away) : null,
    goalMinutes, firstGoalMinute, goalEventsLite,
    corners: { home: cH, away: cA, total: sum(cH, cA) },
    cards: {
      home: cardHome, away: cardAway,
      total: (cardHome == null && cardAway == null) ? null : (cardHome || 0) + (cardAway || 0),
      yellowHome: yh, yellowAway: ya, redHome: rh, redAway: ra,
    },
    reds: { home: rh, away: ra, total: sum(rh, ra) },
    shots: { home: shH, away: shA, total: sum(shH, shA), onTargetHome: soH, onTargetAway: soA, totalOnTarget: sum(soH, soA) },
    fouls: { home: flH, away: flA, total: sum(flH, flA) },
    offsides: { home: oH, away: oA, total: sum(oH, oA) },
    cardsByHalf,
    half,
  };
}

// Refleja un actuals al lado contrario (cuando el local de HOY fue el visitante
// del cruce). Mantiene los campos agnósticos al lado (goalMinutes, totales).
function flipActuals(a) {
  if (!a) return a;
  const swapHA = (o, pairs) => {
    if (!o) return o;
    const r = { ...o, home: o.away, away: o.home };
    if (pairs) for (const [k, alt] of pairs) { r[k] = o[alt]; r[alt] = o[k]; }
    return r;
  };
  const flipRes = (x) => x === 'H' ? 'A' : x === 'A' ? 'H' : x;
  const flipHalfStats = (s) => { if (!s) return s; const out = {}; for (const k of Object.keys(s)) out[k] = swapHA(s[k]); return out; };
  return {
    ...a,
    homeId: a.awayId, awayId: a.homeId,
    result: flipRes(a.result),
    goals: swapHA(a.goals),
    goals1H: swapHA(a.goals1H), goals2H: swapHA(a.goals2H),
    result1H: flipRes(a.result1H), result2H: flipRes(a.result2H),
    corners: swapHA(a.corners),
    cards: swapHA(a.cards, [['yellowHome', 'yellowAway'], ['redHome', 'redAway']]),
    reds: swapHA(a.reds),
    shots: swapHA(a.shots, [['onTargetHome', 'onTargetAway']]),
    fouls: swapHA(a.fouls),
    offsides: swapHA(a.offsides),
    cardsByHalf: a.cardsByHalf ? { firstHalf: swapHA(a.cardsByHalf.firstHalf), secondHalf: swapHA(a.cardsByHalf.secondHalf) } : null,
    half: a.half ? { firstHalf: flipHalfStats(a.half.firstHalf), secondHalf: flipHalfStats(a.half.secondHalf) } : null,
  };
}

// Construye el registro point-in-time-able de UN partido desde el crudo, en la
// perspectiva de `teamId`. fixtureObj = payload de raw 'fixtures'; statsResp =
// payload de raw 'fixtures/statistics' (o null). Devuelve null si no aplica.
function recordFromRaw(fixtureObj, statsResp, teamId, opts = {}) {
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

  // ── Hechos por mitad / timing / rojas / offsides (perspectiva del equipo) ──
  // Reusa buildActuals (misma definición que H2H) y los proyecta a For/Against.
  // eventsResp/halfStats opcionales: sin ellos, los campos por-minuto/HT quedan
  // null (no rompe — los mercados respectivos no se evalúan para ese partido).
  const a = buildActuals(f, statsResp, opts.eventsResp || null, opts.halfStats || null);
  const sf = isHome ? 'home' : 'away', sa = isHome ? 'away' : 'home';
  const halfVal = (block, stat) => block && block[stat] ? block[stat][sf] : null;
  const halfValAg = (block, stat) => block && block[stat] ? block[stat][sa] : null;
  const proj = a ? {
    // goles por mitad
    gfFH: a.goals1H?.[sf] ?? null, gaFH: a.goals1H?.[sa] ?? null,
    gfSH: a.goals2H?.[sf] ?? null, gaSH: a.goals2H?.[sa] ?? null,
    resultFH: a.result1H == null ? null : (a.result1H === 'D' ? 'D' : ((a.result1H === 'H') === isHome ? 'W' : 'L')),
    // rojas / offsides
    redsFor: a.reds?.[sf] ?? null, redsAgainst: a.reds?.[sa] ?? null,
    offsidesFor: a.offsides?.[sf] ?? null, offsidesAgainst: a.offsides?.[sa] ?? null,
    // minutos de gol
    goalMinutesFor: (a.goalEventsLite || []).filter(g => g.teamId === me).map(g => g.minute).sort((x, y) => x - y),
    goalMinutesAll: a.goalMinutes || [],
    firstGoalFor: (a.goalEventsLite && a.goalEventsLite.length)
      ? (a.goalEventsLite.slice().sort((x, y) => x.minute - y.minute)[0]?.teamId === me) : null,
    // tarjetas por mitad (de eventos con minuto)
    cardsForFH: a.cardsByHalf?.firstHalf?.[sf] ?? null, cardsForSH: a.cardsByHalf?.secondHalf?.[sf] ?? null,
    // split HT de stats sin minuto (córners/tiros/faltas/offsides) — forward-only
    cornersForFH: halfVal(a.half?.firstHalf, 'corners'),  cornersForSH: halfVal(a.half?.secondHalf, 'corners'),
    cornersAgainstFH: halfValAg(a.half?.firstHalf, 'corners'), cornersAgainstSH: halfValAg(a.half?.secondHalf, 'corners'),
    shotsForFH: halfVal(a.half?.firstHalf, 'shots'),      shotsForSH: halfVal(a.half?.secondHalf, 'shots'),
    foulsForFH: halfVal(a.half?.firstHalf, 'fouls'),      foulsForSH: halfVal(a.half?.secondHalf, 'fouls'),
    offsidesForFH: halfVal(a.half?.firstHalf, 'offsides'), offsidesForSH: halfVal(a.half?.secondHalf, 'offsides'),
  } : {};

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
    ...proj,
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

module.exports = { RATE_METRICS, AVG_METRICS, ALL_METRICS, FINISHED, statVal, phaseOf, recordFromRaw, buildActuals, flipActuals, computeMetrics, shrink, filterSegment, avg, rate };
