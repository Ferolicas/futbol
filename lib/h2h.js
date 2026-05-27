/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Niveles 2 (H2H específico) y 3 (excepciones causales) del meta-modelo.
// PURO: recibe los crudos ya cargados y computa. Lo usan reenrich, trainer y
// runtime. Reusa MARKET_DEFS para que la "ocurrencia" de cada mercado en un
// cruce sea EXACTAMENTE la misma definición que en el catálogo (paridad).
// ────────────────────────────────────────────────────────────────────────

const { MARKET_DEFS } = require('./meta-features');
const { statVal, phaseOf } = require('./adn');

// Registro de un cruce desde el crudo (fixture + statistics), con valores por
// equipo para poder orientarlo a los equipos de HOY sin importar la localía.
function meetingRecord(fixtureObj, statsResp) {
  const f = fixtureObj || {};
  const homeId = f.teams?.home?.id, awayId = f.teams?.away?.id;
  if (!homeId || !awayId) return null;
  const gh = f.score?.fulltime?.home ?? f.goals?.home;
  const ga = f.score?.fulltime?.away ?? f.goals?.away;
  if (gh == null || ga == null) return null;
  const tv = (tid, type) => statVal(statsResp, tid, type);
  const byTeam = {};
  for (const tid of [homeId, awayId]) {
    const yc = tv(tid, 'Yellow Cards') || 0, rc = tv(tid, 'Red Cards') || 0;
    byTeam[tid] = {
      goals: tid === homeId ? gh : ga,
      corners: tv(tid, 'Corner Kicks'),
      cards: (tv(tid, 'Yellow Cards') == null && tv(tid, 'Red Cards') == null) ? null : yc + rc,
      shots: tv(tid, 'Total Shots'),
      sot: tv(tid, 'Shots on Goal'),
      fouls: tv(tid, 'Fouls'),
    };
  }
  return {
    fixtureId: f.fixture?.id, date: f.fixture?.date, phase: phaseOf(f.league?.round),
    homeId, awayId, byTeam,
  };
}

// Orienta un cruce a los equipos de HOY → objeto tipo actuals_full (home = hoy
// local) para aplicar MARKET_DEFS[market].outcome/gate sin cambios.
function orient(rec, todayHome, todayAway) {
  const H = rec.byTeam[todayHome], A = rec.byTeam[todayAway];
  if (!H || !A || H.goals == null || A.goals == null) return null;
  const sum = (x, y) => (x == null || y == null) ? null : x + y;
  return {
    result: H.goals > A.goals ? 'H' : H.goals < A.goals ? 'A' : 'D',
    goals: { home: H.goals, away: A.goals, total: H.goals + A.goals, btts: H.goals > 0 && A.goals > 0 },
    corners: { home: H.corners, away: A.corners, total: sum(H.corners, A.corners) },
    cards: { home: H.cards, away: A.cards, total: sum(H.cards, A.cards) },
    shots: { home: H.shots, away: A.shots, total: sum(H.shots, A.shots), totalOnTarget: sum(H.sot, A.sot) },
    fouls: { home: H.fouls, away: A.fouls, total: sum(H.fouls, A.fouls) },
  };
}

// Tasa H2H de un mercado (point-in-time: solo cruces con date < cutoff).
// Devuelve {rate, n, exceptions:[{fixtureId,date}]} — exceptions = cruces donde
// el outcome quedó en MINORÍA (el "patrón" no se dio).
function h2hForMarket(meetings, market, todayHome, todayAway, cutoffMs) {
  const def = MARKET_DEFS[market];
  if (!def) return { rate: null, n: 0, exceptions: [] };
  const evals = [];
  for (const m of meetings) {
    if (cutoffMs && new Date(m.date).getTime() >= cutoffMs) continue;
    const o = orient(m, todayHome, todayAway);
    if (!o || !def.gate(o)) continue;
    evals.push({ m, hit: !!def.outcome(o) });
  }
  const n = evals.length;
  if (!n) return { rate: null, n: 0, exceptions: [] };
  const hits = evals.filter(e => e.hit).length;
  const rate = hits / n;
  const majority = rate >= 0.5; // lado dominante
  const exceptions = evals.filter(e => e.hit !== majority).map(e => ({ fixtureId: e.m.fixtureId, date: e.m.date }));
  return { rate, n, exceptions };
}

// Mezcla empírico-bayesiana del H2H con la expectativa del ADN, ponderada por n.
// con n bajo ≈ ADN; con n alto domina el H2H (codifica "H2H pesa más con más n").
function h2hBlend(h2hRate, h2hN, adnExpectation, k = 3) {
  if (h2hRate == null) return adnExpectation;
  if (adnExpectation == null) return h2hRate;
  return (h2hN * h2hRate + k * adnExpectation) / (h2hN + k);
}

// Causa de una excepción, desde los crudos de ESE fixture. ctx = { lineups,
// events, injuries } payloads; modalXI = Set de playerIds del XI habitual del
// equipo (para detectar rotación).
function exceptionCause(fixtureId, ctx, teamId, modalXI) {
  const cause = { earlyRed: false, knockout: false, rotation: false, keyInjury: false };
  // Expulsión temprana (≤ min 60) de cualquier equipo.
  const events = ctx.events?.[fixtureId]?.response || ctx.events?.[fixtureId] || [];
  for (const e of (Array.isArray(events) ? events : [])) {
    if (e?.type === 'Card' && /red/i.test(e?.detail || '') && (e?.time?.elapsed ?? 99) <= 60) cause.earlyRed = true;
  }
  // Lesionados reportados para ese fixture.
  const inj = ctx.injuries?.[fixtureId]?.response || ctx.injuries?.[fixtureId] || [];
  if (Array.isArray(inj) && inj.length > 0) cause.keyInjury = true;
  // Rotación: XI del cruce vs XI habitual del equipo.
  if (modalXI && modalXI.size) {
    const lus = ctx.lineups?.[fixtureId]?.response || ctx.lineups?.[fixtureId] || [];
    const team = (Array.isArray(lus) ? lus : []).find(l => l.team?.id === teamId);
    const xi = (team?.startXI || []).map(p => p.player?.id).filter(Boolean);
    if (xi.length >= 7) {
      const changed = xi.filter(id => !modalXI.has(id)).length;
      if (changed >= 5) cause.rotation = true;
    }
  }
  return cause;
}

// ¿Alguna causa que rompió el patrón está PRESENTE hoy? → score [0-1].
// pastCauses = unión de causas de las excepciones; today = contexto de hoy.
function rupturePresentToday(pastCauses, today) {
  if (!pastCauses) return 0;
  let hits = 0, checks = 0;
  const pairs = [
    [pastCauses.earlyRed, today.earlyRedRisk],   // (rara de anticipar; suele 0)
    [pastCauses.knockout, today.knockout],
    [pastCauses.rotation, today.rotationRisk],
    [pastCauses.keyInjury, today.keyInjury],
  ];
  for (const [past, now] of pairs) { if (past) { checks++; if (now) hits++; } }
  return checks ? hits / checks : 0;
}

// XI modal de un equipo a partir de sus lineups disponibles (raw). Devuelve Set
// de los 11 playerIds más frecuentes como titulares.
function modalXIFromLineups(lineupPayloads, teamId) {
  const freq = new Map();
  for (const lp of lineupPayloads) {
    const arr = lp?.response || lp || [];
    const team = (Array.isArray(arr) ? arr : []).find(l => l.team?.id === teamId);
    for (const p of (team?.startXI || [])) { const id = p.player?.id; if (id) freq.set(id, (freq.get(id) || 0) + 1); }
  }
  return new Set([...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 11).map(([id]) => id));
}

module.exports = { meetingRecord, orient, h2hForMarket, h2hBlend, exceptionCause, rupturePresentToday, modalXIFromLineups };
