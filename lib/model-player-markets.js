/* eslint-disable */
// lib/model-player-markets.js — mercados de JUGADOR (Etapa 3). Frecuencia empírica CRUDA
// de model.player_match_stats (NO las tasas agregadas de player_profiles), igual que el
// núcleo de equipo cuenta de team_match_stats. La temporada actual pesa más que
// el histórico, sin mínimo/máximo de apariciones. GATE DURO: solo jugadores del
// startXI confirmado.
// Mercados: anytime goleador (goals≥1), tiros OU (shots_total), tiros a puerta OU (shots_on),
// tarjeta (yellow+red≥1), faltas OU (fouls_committed). CommonJS. Pura, sin escrituras.

const PM_CURRENT_SHARE = 0.72;
const PM_LINE_PCT = 0.95;  // líneas OU hasta el p95 del soporte observado del jugador
const PM_LINE_CAP = 20;    // tope duro de líneas (tiros/faltas de jugador no pasan de ~10)
const PM_K = 8;            // confianza = n/(n+k)

const round = (x) => (x == null ? null : Math.round(x * 1_000_000) / 1_000_000);
const num = (x) => (x == null ? null : Number(x));
const confOf = (n) => n / (n + PM_K);
const lineKey = (value) => String(value).replace('-', 'm').replace('.', '_');

async function loadPlayerValidation(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT metrics FROM prediction_models
       WHERE sport='football' AND market_key='__empirical_engine__'
         AND model_type='empirical-weighting' AND active=TRUE
       ORDER BY version DESC LIMIT 1`,
    );
    return rows[0]?.metrics?.candidate?.horizons?.confirmed?.families
      || rows[0]?.metrics?.candidate?.families
      || {};
  } catch {
    return {};
  }
}

function marketValidation(catalog, family, probability) {
  const metric = catalog?.[family];
  const band = probability >= 0.95 ? 'elite95' : probability >= 0.90 ? 'daily90' : 'high';
  const segment = metric?.[band];
  return {
    available: !!segment,
    family,
    band,
    n: Number(segment?.n || 0),
    avgPred: segment?.avg_pred == null ? null : Number(segment.avg_pred),
    avgActual: segment?.avg_actual == null ? null : Number(segment.avg_actual),
  };
}

// frecuencia: fn(row)->1|0|null (null se excluye), igual que pRate del núcleo.
function pRate(rows, fn) { let s = 0, n = 0; for (const r of rows) { const v = fn(r); if (v == null) continue; s += v; n++; } return n ? { p: s / n, n, hits: s } : { p: null, n: 0, hits: 0 }; }
function blend(rows, fn, season, currentShare = PM_CURRENT_SHARE) {
  const current = pRate(rows.filter((r) => season != null && Number(r.season) === Number(season)), fn);
  const historical = pRate(rows.filter((r) => season == null || Number(r.season) !== Number(season)), fn);
  if (current.n && historical.n) return { p: currentShare * current.p + (1 - currentShare) * historical.p, n: current.n + historical.n, hits: current.hits + historical.hits };
  if (current.n) return current;
  return historical;
}
function percentile(vals, q) { const a = vals.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))]; }

// historial del jugador (apariciones reales, antes del cutoff), agrupado por player_id desc.
async function fetchPlayerHistory(pool, playerIds, cutoff) {
  const { rows } = await pool.query(
    `SELECT player_id, kickoff, season, goals, shots_total, shots_on, yellow, red, fouls_committed
     FROM model.player_match_stats
     WHERE player_id = ANY($1::bigint[]) AND minutes > 0 AND kickoff < $2
     ORDER BY player_id, kickoff DESC`, [playerIds.map(Number), cutoff]);
  const byPlayer = new Map();
  for (const r of rows) { const k = Number(r.player_id); if (!byPlayer.has(k)) byPlayer.set(k, []); byPlayer.get(k).push(r); }
  return byPlayer;
}

// OU de una métrica del jugador: líneas sobre el soporte observado, frecuencia 70/30.
function ouMarket(rows, valFn, season, currentShare, validationCatalog, familyPrefix) {
  const vals = rows.map(valFn).filter((v) => v != null);
  if (!vals.length) return null;
  const hi = Math.max(0.5, Math.min(percentile(vals, PM_LINE_PCT), PM_LINE_CAP));
  const lines = [];
  for (let L = 0.5; L <= hi; L += 1) lines.push(L);
  const out = [];
  for (const L of lines) {
    const e = blend(rows, (r) => { const v = valFn(r); return v == null ? null : (v > L ? 1 : 0); }, season, currentShare);
    if (e.p == null) continue;
    out.push({
      line: L, prob: round(e.p), n: e.n, conf: round(confOf(e.n)),
      validation: marketValidation(validationCatalog, `${familyPrefix}_over_${lineKey(L)}`, e.p),
    });
  }
  return out.length ? { kind: 'ou', lines: out } : null;
}
function boolMarket(rows, fn, season, currentShare, validationCatalog, family) {
  const e = blend(rows, fn, season, currentShare); if (e.p == null) return null;
  return {
    kind: 'bool', prob: round(e.p), n: e.n, conf: round(confOf(e.n)),
    validation: marketValidation(validationCatalog, family, e.p),
  };
}

// startXI: [{ player_id|id, team_id?, name?, position? }] (titulares CONFIRMADOS de model.lineups).
// Devuelve { [player_id]: { player_id, name, team_id, n, markets } }. Una sola
// aparición ya es evidencia. El caller solo pasa el startXI confirmado.
async function buildPlayerMarkets(pool, startXI, { cutoff, season, currentShare = PM_CURRENT_SHARE } = {}) {
  if (!Array.isArray(startXI) || !startXI.length) return {};
  const ids = [...new Set(startXI.map((p) => Number(p.player_id || p.id)).filter(Boolean))];
  if (!ids.length) return {};
  const hist = await fetchPlayerHistory(pool, ids, cutoff || new Date());
  const validationCatalog = await loadPlayerValidation(pool);
  const activeShare = Math.max(0.55, Math.min(0.95, Number(currentShare) || PM_CURRENT_SHARE));
  const out = {};
  for (const p of startXI) {
    const pid = Number(p.player_id || p.id); if (!pid || out[pid]) continue;
    const rows = hist.get(pid) || [];
    if (!rows.length) continue;
    const markets = {};
    const scorer = boolMarket(rows, (r) => (r.goals == null ? null : (r.goals > 0 ? 1 : 0)), season, activeShare, validationCatalog, 'player_scorer');
    if (scorer) markets.anytime_scorer = scorer;
    const carded = boolMarket(rows, (r) => { const y = num(r.yellow), rd = num(r.red); if (y == null && rd == null) return null; return ((y || 0) + (rd || 0)) > 0 ? 1 : 0; }, season, activeShare, validationCatalog, 'player_booked');
    if (carded) markets.to_be_carded = carded;
    const shots = ouMarket(rows, (r) => num(r.shots_total), season, activeShare, validationCatalog, 'player_shotsTotal');      if (shots) markets.shots = shots;
    const sot = ouMarket(rows, (r) => num(r.shots_on), season, activeShare, validationCatalog, 'player_shotsOn');           if (sot) markets.shots_on = sot;
    const fouls = ouMarket(rows, (r) => num(r.fouls_committed), season, activeShare, validationCatalog, 'player_fouls');  if (fouls) markets.fouls = fouls;
    if (Object.keys(markets).length) out[pid] = { player_id: pid, name: p.name || null, team_id: p.team_id != null ? Number(p.team_id) : null, n: rows.length, markets };
  }
  return out;
}

module.exports = { buildPlayerMarkets };
