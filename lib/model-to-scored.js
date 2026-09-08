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

const REC_MIN_PROB = 0.80;   // recomendación general; las vistas diarias aplican su política al final
const K = 12;                // confianza de las familias derivadas sin conf propia: n/(n+K)
const {
  assessValidation,
  calibrateProbability,
  probabilityValidationBand,
} = require('./prediction-math.cjs');

const round = (x) => (x == null ? null : Math.round(x * 1_000_000) / 1_000_000);
const confFromN = (n) => (n ? n / (n + K) : 0);
const lineDiagnosticKey = (marketKey, direction, line) =>
  `${marketKey}_${direction}_${String(line).replace('.', '_')}`;

// Contrato visual: el ledger conserva frecuencia empírica y calibrada con seis
// decimales. Solo el campo de presentación se limita a 95%; por debajo se
// trunca a dos decimales para que 94.999% nunca se convierta visualmente en un
// 95% que el modelo no calculó.
function displayPct(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const pct = Math.max(0, Math.min(100, Number(value)));
  if (pct >= 95) return 95;
  return Math.floor((pct + 1e-9) * 100) / 100;
}

// familias OU del motor que TIENEN destino en la shape de context (mismo flip de scope).
// Córners por equipo y mitad no forman parte del catálogo comercial antiguo,
// pero sí del informe privado del propietario. Se conservan en `scored` aunque
// no tengan cuota: el adaptador comercial seguirá ignorándolos.
const OU_FAMILIES = new Set([
  'goals', 'corners', 'cards', 'shots', 'sot', 'fouls', 'offsides',
  'goals_1h', 'goals_2h', 'corners_1h', 'corners_2h',
]);

// entrada de scored desde una prob_final + metadatos del motor.
function validationFor(probability, family, validationFamilies) {
  const hasValidation = validationFamilies && Object.keys(validationFamilies).length > 0;
  if (!hasValidation) return {
    available: false,
    family: family || null,
  };
  const metric = family ? validationFamilies[family] : null;
  const band = probabilityValidationBand(probability);
  // Los modelos anteriores a selectable70 conservan un fallback al segmento
  // global. Los modelos nuevos siempre incluyen la cohorte >=70% exacta.
  const segment = band === 'all'
    ? metric
    : (metric?.[band] || (band === 'selectable70' ? metric : null));
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

function entry(prob_final, level, n, conf, hits = null, family = null, diagnostics = {}) {
  if (prob_final == null) return null;
  const rawProbability = Math.max(0, Math.min(1, prob_final));
  // La corrección se aprende exclusivamente con train. Su resultado se juzga
  // contra validation, que nunca participó en el ajuste. Antes se usaba el
  // mismo bucket para ambas cosas y luego se evaluaba el bucket crudo, por lo
  // que una corrección válida seguía quedando bloqueada para siempre.
  const calibration = validationFor(rawProbability, family, diagnostics.calibrationFamilies);
  const calibratedProbability = calibrateProbability(rawProbability, calibration);
  const validation = validationFor(calibratedProbability, family, diagnostics.validationFamilies);
  const validationDecision = assessValidation(validation);
  return {
    prob: rawProbability,
    prob_raw: rawProbability,
    prob_calibrated: calibratedProbability,
    prob_final: calibratedProbability,
    level: level || 'empirical',
    n: n || 0,
    hits: hits == null ? null : Number(hits),
    confidence: conf != null ? conf : confFromN(n),
    // La frecuencia cruda nunca se borra, pero solo una familia respaldada por
    // validación temporal puede convertirse en recomendación.
    recommended: calibratedProbability >= REC_MIN_PROB && validationDecision.eligible,
    validation: { ...validation, calibration, decision: validationDecision },
  };
}

// "goals_1h_total" → { fam:'goals_1h', scope:'total' }. Sufijo = último _total|_home|_away.
function splitScope(key) {
  const m = key.match(/^(.+)_(total|home|away)$/);
  return m ? { fam: m[1], scope: m[2] } : null;
}

// Traduce predict().markets → scored plano (claves canónicas de context-probabilities).
function modelToScored(markets, { calibrationFamilies = null, validationFamilies = null } = {}) {
  const scored = {};
  if (!markets || typeof markets !== 'object') return scored;
  const set = (k, e) => { if (e) scored[k] = e; };
  const makeEntry = (...args) => entry(...args, { calibrationFamilies, validationFamilies });

  for (const [key, mk] of Object.entries(markets)) {
    if (!mk) continue;

    // ── OU: goals/corners/cards/shots/sot/fouls/offsides (+ goals 1h/2h) ──
    if (mk.kind === 'ou') {
      const sp = splitScope(key);
      if (!sp || !OU_FAMILIES.has(sp.fam)) continue;          // por-mitad de equipo y desconocidas → omitidas
      const base = `${sp.scope}_${sp.fam}`;                   // FLIP: goals_total → total_goals
      for (const ln of (mk.lines || [])) {
        const N = Math.round(ln.line - 0.5);                  // 2.5 → 2
        set(`${base}_over${N}_5`,  makeEntry(ln.prob, ln.level, ln.n, ln.conf, ln.hits, lineDiagnosticKey(key, 'over', ln.line)));
        set(`${base}_under${N}_5`, makeEntry(ln.prob == null ? null : round(1 - ln.prob), ln.level, ln.n, ln.underConf ?? ln.conf, ln.hits == null ? null : ln.n - ln.hits, lineDiagnosticKey(key, 'under', ln.line)));
      }
      continue;
    }

    // ── 1X2 ──
    if (mk.kind === 'result') {
      set('home_win', makeEntry(mk.home, mk.level, mk.n, mk.homeConf ?? mk.conf, null, '1x2_home'));
      set('draw',     makeEntry(mk.draw, mk.level, mk.n, mk.drawConf ?? mk.conf, null, '1x2_draw'));
      set('away_win', makeEntry(mk.away, mk.level, mk.n, mk.awayConf ?? mk.conf, null, '1x2_away'));
      continue;
    }

    // ── booleanos ──
    if (mk.kind === 'bool') {
      if (key === 'btts') {
        set('btts',    makeEntry(mk.prob, mk.level, mk.n, mk.conf, mk.hits, 'btts'));
        set('btts_no', makeEntry(mk.prob == null ? null : round(1 - mk.prob), mk.level, mk.n, mk.inverseConf ?? mk.conf, mk.hits == null ? null : mk.n - mk.hits, 'btts_no'));
      } else if (key === 'first_goal_1h') {
        set('first_goal_45', makeEntry(mk.prob, mk.level, mk.n, mk.conf, null, key));   // motor: primer gol ≤45' = "antes del 45"
      } else if (key === 'clean_sheet_home' || key === 'clean_sheet_away' || key === 'red_card_home' || key === 'red_card_away' || key === 'red_card_any') {
        set(key, makeEntry(mk.prob, mk.level, mk.n, mk.conf, null, key));               // mismas claves en ambos lados
      }
      continue;
    }

    // ── derivadas multi ──
    if (mk.kind === 'multi') {
      const n1x2 = markets['1x2']?.n || 0, c1x2 = markets['1x2']?.conf;
      if (key === 'double_chance') {
        set('dc_1x', makeEntry(mk['1X'], 'derived', mk.n || n1x2, mk.conf1X ?? c1x2, null, 'dc_1x'));
        set('dc_12', makeEntry(mk['12'], 'derived', mk.n || n1x2, mk.conf12 ?? c1x2, null, 'dc_12'));
        set('dc_x2', makeEntry(mk['X2'], 'derived', mk.n || n1x2, mk.confX2 ?? c1x2, null, 'dc_x2'));
      } else if (key === 'odd_even') {
        set('goals_odd',  makeEntry(mk.odd,  'derived', mk.n, mk.oddConf ?? confFromN(mk.n), null, 'goals_odd'));
        set('goals_even', makeEntry(mk.even, 'derived', mk.n, mk.evenConf ?? confFromN(mk.n), null, 'goals_even'));
      } else if (key === 'handicap_home_asian') {
        // hándicap asiático LOCAL: m0.5/m1.5 = local con −0.5/−1.5; p0.5/p1.5 = +0.5/+1.5.
        // (cubre con prob acumulada del diferencial). resolveOddField mapea ah_home_* → asianHandicap.
        for (const k of ['m0.5', 'm1.5', 'p0.5', 'p1.5']) {
          const family = `ah_home_${k.replace('.', '_')}`;
          set(family, makeEntry(mk[k], 'derived', n1x2, c1x2, null, family));
        }
      } else if (key === 'handicap_home_eu') {
        for (const k of ['m1', 'p1']) set(`eh_home_${k}`, makeEntry(mk[k], 'derived', n1x2, c1x2, null, `eh_home_${k}`));   // hándicap europeo (3-way) local ∓1
      }
      continue;
    }

    // ── marcador exacto → correctScore (cs_h_a, cada scoreline) + exact_goals_N (TOTAL de goles) ──
    if (mk.kind === 'list' && key === 'exact_score') {
      for (const e of (mk.lines || [])) {
        const [h, a] = String(e.score).split('-').map(Number);
        if (!isFinite(h) || !isFinite(a)) continue;
        set(`cs_${h}_${a}`, makeEntry(round(e.prob), 'derived', mk.n, confFromN(mk.n), null, `cs_${h}_${a}`));   // marcador exacto h-a → resolveOddField cs_* → correctScore
      }
      // Los totales exactos salen de TODA la matriz matemática. `mk.lines` es
      // únicamente el subconjunto visual de marcadores con mayor probabilidad.
      for (const [bucket, p] of Object.entries(mk.totalProbabilities || {})) {
        set(`exact_goals_${bucket}`, makeEntry(round(p), 'derived', mk.n, confFromN(mk.n), null, `exact_goals_${bucket}`));
      }
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
        validation: market?.validation || null,
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
