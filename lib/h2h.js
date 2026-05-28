/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Niveles 2 (H2H específico) y 3 (excepciones causales) del meta-modelo.
// PURO: recibe los crudos ya cargados y computa. Lo usan reenrich, trainer y
// runtime. Reusa MARKET_DEFS para que la "ocurrencia" de cada mercado en un
// cruce sea EXACTAMENTE la misma definición que en el catálogo (paridad).
// ────────────────────────────────────────────────────────────────────────

const { MARKET_DEFS } = require('./meta-features');
const { buildActuals, flipActuals } = require('./adn');

// Registro de un cruce desde el crudo. Guarda el objeto canónico de hechos
// (buildActuals, perspectiva home/away del propio cruce) + ids/fecha. eventsResp
// y halfStats son opcionales (minutos de gol/tarjeta y split HT); sin ellos los
// mercados por minuto / por mitad de stats sin-minuto no se evalúan para el cruce.
function meetingRecord(fixtureObj, statsResp, eventsResp, halfStats) {
  const f = fixtureObj || {};
  const actuals = buildActuals(f, statsResp, eventsResp, halfStats);
  if (!actuals) return null;
  return {
    fixtureId: f.fixture?.id, date: f.fixture?.date, phase: actuals.phase,
    homeId: actuals.homeId, awayId: actuals.awayId, actuals,
  };
}

// Orienta un cruce a los equipos de HOY → mismo objeto canónico que evalúa el
// ADN (home = local de HOY) para aplicar MARKET_DEFS[market].outcome/gate sin
// ninguna divergencia. Reflejado con flipActuals si la localía estaba invertida.
function orient(rec, todayHome, todayAway) {
  const a = rec?.actuals;
  if (!a) return null;
  if (todayHome === a.homeId && todayAway === a.awayId) return a;
  if (todayHome === a.awayId && todayAway === a.homeId) return flipActuals(a);
  return null; // el cruce no es entre exactamente estos dos equipos
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
// `meeting` (opcional) = el meetingRecord del cruce → habilita las causas
// knockout/final (de su fase) y venue (localía del equipo en ese cruce). Sin
// `meeting` (llamadas legacy de 4 args), esas dos quedan false/null y el resto
// se comporta igual que antes.
function exceptionCause(fixtureId, ctx, teamId, modalXI, meeting = null) {
  const cause = { earlyRed: false, knockout: false, rotation: false, keyInjury: false, venue: null };
  // Expulsión temprana (≤ min 60) de cualquier equipo.
  const events = ctx.events?.[fixtureId]?.response || ctx.events?.[fixtureId] || [];
  for (const e of (Array.isArray(events) ? events : [])) {
    if (e?.type === 'Card' && /red/i.test(e?.detail || '') && (e?.time?.elapsed ?? 99) <= 60) cause.earlyRed = true;
  }
  // Eliminatoria / fase (del round del cruce).
  if (meeting && (meeting.phase === 'knockout' || meeting.phase === 'final')) cause.knockout = true;
  // Venue del equipo en ese cruce (para comparar con la localía de hoy).
  if (meeting) cause.venue = meeting.homeId === teamId ? 'home' : meeting.awayId === teamId ? 'away' : null;
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
