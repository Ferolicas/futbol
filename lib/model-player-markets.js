/* eslint-disable */
// lib/model-player-markets.js — mercados de JUGADOR (Etapa 3). Frecuencia empírica CRUDA
// de model.player_match_stats (NO las tasas agregadas de player_profiles), igual que el
// núcleo de equipo cuenta de team_match_stats. 70/30 (últimas 10 apariciones al 70% / todo
// el historial al 30%), muestra mínima, y GATE DURO: solo jugadores del startXI confirmado.
// Mercados: anytime goleador (goals≥1), tiros OU (shots_total), tiros a puerta OU (shots_on),
// tarjeta (yellow+red≥1), faltas OU (fouls_committed). CommonJS. Pura, sin escrituras.

const PM_MIN_N = 5;        // muestra mínima de apariciones para emitir mercados del jugador
const PM_LAST_N = 10;      // ventana reciente (70%); el resto del historial pesa 30%
const PM_LINE_PCT = 0.95;  // líneas OU hasta el p95 del soporte observado del jugador
const PM_LINE_CAP = 20;    // tope duro de líneas (tiros/faltas de jugador no pasan de ~10)
const PM_K = 8;            // confianza = n/(n+k)

const round = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const num = (x) => (x == null ? null : Number(x));
const confOf = (n) => n / (n + PM_K);

// frecuencia: fn(row)->1|0|null (null se excluye), igual que pRate del núcleo.
function pRate(rows, fn) { let s = 0, n = 0; for (const r of rows) { const v = fn(r); if (v == null) continue; s += v; n++; } return n ? { p: s / n, n } : { p: null, n: 0 }; }
// 70/30: últimas 10 apariciones (rows ya en orden desc) al 70%, todo el historial al 30%.
// Con ≤10 apariciones, last10 = todas → colapsa al mismo valor (sin romper).
function blend(rows, fn) {
  const all = pRate(rows, fn); if (all.n === 0) return { p: null, n: 0 };
  const last = pRate(rows.slice(0, PM_LAST_N), fn);
  return { p: last.p == null ? all.p : 0.7 * last.p + 0.3 * all.p, n: all.n };
}
function percentile(vals, q) { const a = vals.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))]; }

// historial del jugador (apariciones reales, antes del cutoff), agrupado por player_id desc.
async function fetchPlayerHistory(pool, playerIds, cutoff) {
  const { rows } = await pool.query(
    `SELECT player_id, kickoff, goals, shots_total, shots_on, yellow, red, fouls_committed
     FROM model.player_match_stats
     WHERE player_id = ANY($1::bigint[]) AND minutes > 0 AND kickoff < $2
     ORDER BY player_id, kickoff DESC`, [playerIds.map(Number), cutoff]);
  const byPlayer = new Map();
  for (const r of rows) { const k = Number(r.player_id); if (!byPlayer.has(k)) byPlayer.set(k, []); byPlayer.get(k).push(r); }
  return byPlayer;
}

// OU de una métrica del jugador: líneas sobre el soporte observado, frecuencia 70/30.
function ouMarket(rows, valFn) {
  const vals = rows.map(valFn).filter((v) => v != null);
  if (!vals.length) return null;
  const hi = Math.min(percentile(vals, PM_LINE_PCT), PM_LINE_CAP);
  const lines = [];
  for (let L = 0.5; L < hi; L += 1) lines.push(L);
  if (!lines.length) return null;                       // jugador que nunca registra esa métrica → sin mercado
  const out = [];
  for (const L of lines) {
    const e = blend(rows, (r) => { const v = valFn(r); return v == null ? null : (v > L ? 1 : 0); });
    if (e.p == null) continue;
    out.push({ line: L, prob: round(e.p), n: e.n, conf: round(confOf(e.n)) });
  }
  return out.length ? { kind: 'ou', lines: out } : null;
}
function boolMarket(rows, fn) {
  const e = blend(rows, fn); if (e.p == null) return null;
  return { kind: 'bool', prob: round(e.p), n: e.n, conf: round(confOf(e.n)) };
}

// startXI: [{ player_id|id, team_id?, name?, position? }] (titulares CONFIRMADOS de model.lineups).
// Devuelve { [player_id]: { player_id, name, team_id, n, markets } } solo para quienes cumplen
// muestra mínima. GATE DURO: el caller solo pasa el startXI confirmado (sin lineup → {}).
async function buildPlayerMarkets(pool, startXI, { cutoff } = {}) {
  if (!Array.isArray(startXI) || !startXI.length) return {};
  const ids = [...new Set(startXI.map((p) => Number(p.player_id || p.id)).filter(Boolean))];
  if (!ids.length) return {};
  const hist = await fetchPlayerHistory(pool, ids, cutoff || new Date());
  const out = {};
  for (const p of startXI) {
    const pid = Number(p.player_id || p.id); if (!pid || out[pid]) continue;
    const rows = hist.get(pid) || [];
    if (rows.length < PM_MIN_N) continue;               // muestra insuficiente → este jugador queda sin mercados
    const markets = {};
    const scorer = boolMarket(rows, (r) => (r.goals == null ? null : (r.goals > 0 ? 1 : 0)));
    if (scorer) markets.anytime_scorer = scorer;
    const carded = boolMarket(rows, (r) => { const y = num(r.yellow), rd = num(r.red); if (y == null && rd == null) return null; return ((y || 0) + (rd || 0)) > 0 ? 1 : 0; });
    if (carded) markets.to_be_carded = carded;
    const shots = ouMarket(rows, (r) => num(r.shots_total));      if (shots) markets.shots = shots;
    const sot = ouMarket(rows, (r) => num(r.shots_on));           if (sot) markets.shots_on = sot;
    const fouls = ouMarket(rows, (r) => num(r.fouls_committed));  if (fouls) markets.fouls = fouls;
    if (Object.keys(markets).length) out[pid] = { player_id: pid, name: p.name || null, team_id: p.team_id != null ? Number(p.team_id) : null, n: rows.length, markets };
  }
  return out;
}

module.exports = { buildPlayerMarkets };
