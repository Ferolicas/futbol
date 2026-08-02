/* eslint-disable */
// lib/model-to-scored.js — ADAPTER (Etapa 4): traduce la salida del MOTOR NUEVO
// (predict() de model-engine.js, schema `model`) al dict plano `scored` que YA
// consumen buildProbabilitiesFromContext + buildContextCombinada (context-probabilities.js).
//
//   scored: { market_key: { prob, prob_final, level, n, hits, confidence, recommended } }
//
// DISEÑO: NO se reescribe la shape. Se reusan los dos builders probados (shape de
// calculatedProbabilities + combinada IDÉNTICA → el frontend no cambia). El filtro de
// cuota 1.20, el veto por datos y el funnel viven en buildContextCombinada (oddFor/
// MIN_ODD) y aplican GRATIS sobre todas las familias que mapeamos aquí. CommonJS, pura.
//
// FLIP DE NOMBRES: el motor usa `${familia}_${scope}` (goals_total, corners_home,
// goals_1h_away); context usa `${scope}_${familia}` (total_goals, home_corners,
// away_goals_1h). El mapeo invierte ese orden. Líneas OU del motor traen solo el OVER;
// el UNDER es el complemento (eventos enteros en .5: under_X_5 = 1 − over_X_5).

const REC_MIN_PROB = 0.80;   // la app recomienda solo cumplimiento real ≥80%; la apuesta diaria exige ≥90%
const K = 12;                // confianza de las familias derivadas sin conf propia: n/(n+K)

const round = (x) => (x == null ? null : Math.round(x * 1_000_000) / 1_000_000);
const confFromN = (n) => (n ? n / (n + K) : 0);
const lineDiagnosticKey = (marketKey, direction, line) =>
  `${marketKey}_${direction}_${String(line).replace('.', '_')}`;

// Contrato visual: `prob_final` conserva la frecuencia real con seis decimales
// y es la única usada para filtros/cálculos. Solo el campo de presentación se
// limita a 95%; por debajo se trunca a dos decimales para que 94.999% nunca se
// convierta visualmente en un 95% que el modelo no calculó.
function displayPct(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const pct = Math.max(0, Math.min(100, Number(value)));
  if (pct >= 95) return 95;
  return Math.floor((pct + 1e-9) * 100) / 100;
}

// familias OU del motor que TIENEN destino en la shape de context (mismo flip de scope).
// Las por-mitad de equipo (corners_1h/shots_1h/sot_1h/fouls_1h + _2h) NO están: la shape
// vieja no tiene campo ni cuota para ellas → se omiten aquí (decisión pendiente de extensión).
const OU_FAMILIES = new Set(['goals', 'corners', 'cards', 'shots', 'sot', 'fouls', 'offsides', 'goals_1h', 'goals_2h']);

// entrada de scored desde una prob_final + metadatos del motor.
function validationFor(probability, family, validationFamilies) {
  const hasValidation = validationFamilies && Object.keys(validationFamilies).length > 0;
  if (!hasValidation) return {
    available: false,
    family: family || null,
  };
  const metric = family ? validationFamilies[family] : null;
  const band = probability >= 0.95 ? 'elite95' : probability >= 0.90 ? 'daily90' : 'high';
  const segment = metric?.[band];
  const avgPred = segment?.avg_pred == null ? null : Number(segment.avg_pred);
  const avgActual = segment?.avg_actual == null ? null : Number(segment.avg_actual);
  return {
    available: !!segment,
    family: family || null,
    band,
    n: Number(segment?.n || 0),
    avgPred,
    avgActual,
    gap: segment?.gap == null
      ? (avgPred == null || avgActual == null ? null : Math.abs(avgPred - avgActual))
      : Number(segment.gap),
  };
}

function entry(prob_final, level, n, conf, hits = null, family = null, validationFamilies = null) {
  if (prob_final == null) return null;
  const p = Math.max(0, Math.min(1, prob_final));
  const validation = validationFor(p, family, validationFamilies);
  return {
    prob: p,
    prob_final: p,
    level: level || 'empirical',
    n: n || 0,
    hits: hits == null ? null : Number(hits),
    confidence: conf != null ? conf : confFromN(n),
    // La recomendación depende exclusivamente de la frecuencia calculada. La
    // validación cronológica adjunta es diagnóstico y jamás actúa como gate.
    recommended: p >= REC_MIN_PROB,
    validation,
  };
}

// "goals_1h_total" → { fam:'goals_1h', scope:'total' }. Sufijo = último _total|_home|_away.
function splitScope(key) {
  const m = key.match(/^(.+)_(total|home|away)$/);
  return m ? { fam: m[1], scope: m[2] } : null;
}

// Traduce predict().markets → scored plano (claves canónicas de context-probabilities).
function modelToScored(markets, { validationFamilies = null } = {}) {
  const scored = {};
  if (!markets || typeof markets !== 'object') return scored;
  const set = (k, e) => { if (e) scored[k] = e; };

  for (const [key, mk] of Object.entries(markets)) {
    if (!mk) continue;

    // ── OU: goals/corners/cards/shots/sot/fouls/offsides (+ goals 1h/2h) ──
    if (mk.kind === 'ou') {
      const sp = splitScope(key);
      if (!sp || !OU_FAMILIES.has(sp.fam)) continue;          // por-mitad de equipo y desconocidas → omitidas
      const base = `${sp.scope}_${sp.fam}`;                   // FLIP: goals_total → total_goals
      for (const ln of (mk.lines || [])) {
        const N = Math.round(ln.line - 0.5);                  // 2.5 → 2
        set(`${base}_over${N}_5`,  entry(ln.prob, ln.level, ln.n, ln.conf, ln.hits, lineDiagnosticKey(key, 'over', ln.line), validationFamilies));
        set(`${base}_under${N}_5`, entry(ln.prob == null ? null : round(1 - ln.prob), ln.level, ln.n, ln.conf, ln.hits == null ? null : ln.n - ln.hits, lineDiagnosticKey(key, 'under', ln.line), validationFamilies));
      }
      continue;
    }

    // ── 1X2 ──
    if (mk.kind === 'result') {
      set('home_win', entry(mk.home, mk.level, mk.n, mk.conf, null, '1x2_home', validationFamilies));
      set('draw',     entry(mk.draw, mk.level, mk.n, mk.conf, null, '1x2_draw', validationFamilies));
      set('away_win', entry(mk.away, mk.level, mk.n, mk.conf, null, '1x2_away', validationFamilies));
      continue;
    }

    // ── booleanos ──
    if (mk.kind === 'bool') {
      if (key === 'btts') {
        set('btts',    entry(mk.prob, mk.level, mk.n, mk.conf, mk.hits, 'btts', validationFamilies));
        set('btts_no', entry(mk.prob == null ? null : round(1 - mk.prob), mk.level, mk.n, mk.conf, mk.hits == null ? null : mk.n - mk.hits, 'btts_no', validationFamilies));
      } else if (key === 'first_goal_1h') {
        set('first_goal_45', entry(mk.prob, mk.level, mk.n, mk.conf, null, key, validationFamilies));   // motor: primer gol ≤45' = "antes del 45"
      } else if (key === 'clean_sheet_home' || key === 'clean_sheet_away' || key === 'red_card_home' || key === 'red_card_away' || key === 'red_card_any') {
        set(key, entry(mk.prob, mk.level, mk.n, mk.conf, null, key, validationFamilies));               // mismas claves en ambos lados
      }
      continue;
    }

    // ── derivadas multi ──
    if (mk.kind === 'multi') {
      const n1x2 = markets['1x2']?.n || 0, c1x2 = markets['1x2']?.conf;
      if (key === 'double_chance') {
        set('dc_1x', entry(mk['1X'], 'derived', n1x2, c1x2, null, null, validationFamilies));
        set('dc_12', entry(mk['12'], 'derived', n1x2, c1x2, null, null, validationFamilies));
        set('dc_x2', entry(mk['X2'], 'derived', n1x2, c1x2, null, null, validationFamilies));
      } else if (key === 'odd_even') {
        set('goals_odd',  entry(mk.odd,  'derived', mk.n, confFromN(mk.n), null, null, validationFamilies));
        set('goals_even', entry(mk.even, 'derived', mk.n, confFromN(mk.n), null, null, validationFamilies));
      } else if (key === 'handicap_home_asian') {
        // hándicap asiático LOCAL: m0.5/m1.5 = local con −0.5/−1.5; p0.5/p1.5 = +0.5/+1.5.
        // (cubre con prob acumulada del diferencial). resolveOddField mapea ah_home_* → asianHandicap.
        for (const k of ['m0.5', 'm1.5', 'p0.5', 'p1.5']) set(`ah_home_${k.replace('.', '_')}`, entry(mk[k], 'derived', n1x2, c1x2, null, null, validationFamilies));
      } else if (key === 'handicap_home_eu') {
        for (const k of ['m1', 'p1']) set(`eh_home_${k}`, entry(mk[k], 'derived', n1x2, c1x2, null, null, validationFamilies));   // hándicap europeo (3-way) local ∓1
      }
      continue;
    }

    // ── marcador exacto → correctScore (cs_h_a, cada scoreline) + exact_goals_N (TOTAL de goles) ──
    if (mk.kind === 'list' && key === 'exact_score') {
      const byTotal = {};
      for (const e of (mk.lines || [])) {
        const [h, a] = String(e.score).split('-').map(Number);
        if (!isFinite(h) || !isFinite(a)) continue;
        set(`cs_${h}_${a}`, entry(round(e.prob), 'derived', mk.n, confFromN(mk.n), null, null, validationFamilies));   // marcador exacto h-a → resolveOddField cs_* → correctScore
        const t = h + a; const bucket = t >= 7 ? '7plus' : String(t);
        byTotal[bucket] = (byTotal[bucket] || 0) + (e.prob || 0);
      }
      for (const [bucket, p] of Object.entries(byTotal)) set(`exact_goals_${bucket}`, entry(round(p), 'derived', mk.n, confFromN(mk.n), null, null, validationFamilies));
      continue;
    }
  }
  return scored;
}

// ── Player props del MODELO → selecciones de combinada (scope:'player') ──
// playerMarkets: { [player_id]: { player_id, name, team_id, n, markets:{ anytime_scorer, to_be_carded, shots, shots_on, fouls } } }
// (de buildPlayerMarkets, Etapa 3). Devuelve entradas crudas en la shape de selección
// que ya usa buildContextCombinada para los player props; la ATRIBUCIÓN a bookmaker con
// cuota ≥1.20 la hace attributePlayer(sel, allBookmakerOdds) en context-probabilities.js
// (mismo gate inviolable). `category` usa el sufijo -<player_id> que espera attributePlayer.
function playerMarketsToSelections(playerMarkets) {
  const out = [];
  if (!playerMarkets || typeof playerMarkets !== 'object') return out;
  const pct = (p) => displayPct(p * 100);
  for (const pm of Object.values(playerMarkets)) {
    const id = pm.player_id, name = pm.name, m = pm.markets || {};
    const push = (cat, market, line, label) => {
      const prob = market?.prob;
      if (prob == null) return;
      const rawConfidence = Number(market?.conf);
      const sampleN = Number(market?.n ?? pm.n ?? 0);
      out.push({
        id: `${cat}-${id}${line != null ? '-' + line : ''}`,
        category: `${cat}-${id}`,
        scope: 'player',
        playerId: id,
        playerName: name,
        name: label,
        probability: pct(prob),
        rawProbability: prob * 100,
        confidence: Number.isFinite(rawConfidence) ? rawConfidence * 100 : null,
        confidenceRaw: Number.isFinite(rawConfidence) ? rawConfidence : null,
        sampleN: Number.isFinite(sampleN) ? sampleN : 0,
        _line: line != null ? line : undefined,
      });
    };
    if (m.anytime_scorer) push('scorer', m.anytime_scorer, null, `${name} marca`);
    if (m.to_be_carded)   push('booked', m.to_be_carded, null, `${name} tarjeta`);
    for (const ln of (m.shots?.lines || []))    push('shotsTotal', ln, ln.line, `${name} +${ln.line} tiros`);
    for (const ln of (m.shots_on?.lines || [])) push('shotsOn',    ln, ln.line, `${name} +${ln.line} tiros a puerta`);
    for (const ln of (m.fouls?.lines || []))    push('fouls',      ln, ln.line, `${name} +${ln.line} faltas`);
  }
  return out;
}

module.exports = { modelToScored, playerMarketsToSelections, displayPct, REC_MIN_PROB };
