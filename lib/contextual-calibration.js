// Runtime del meta-modelo contextual (Paso 4). Donde hay modelo ACTIVO que
// superó al baseline, recalibra la probabilidad combinando ADN (L1) + H2H (L2)
// + excepciones (L3); donde no, deja la isotónica (que ya corrió antes). Aplica
// a AMBOS lados de cada mercado (catálogo simétrico) y adjunta un score de
// confianza por mercado para la supresión por baja confianza.
//
// Gated por env CONTEXTUAL_MODEL_ENABLED='true' → inerte hasta activarlo tras
// revisar el entrenamiento. Sin modelos activos también es no-op.

import { supabaseAdmin } from './supabase';
import { buildMetaFeatures, predictWithModel, MARKET_DEFS } from './meta-features';
import { buildFeatureSnapshot } from './feature-snapshot';
import { meetingRecord, h2hForMarket, rupturePresentToday } from './h2h';

const CACHE_TTL = 60 * 60 * 1000;
let modelCache = null, modelCacheAt = 0;

function enabled() { return process.env.CONTEXTUAL_MODEL_ENABLED === 'true'; }

async function loadActiveModels() {
  const now = Date.now();
  if (modelCache && now - modelCacheAt < CACHE_TTL) return modelCache;
  try {
    const { data } = await supabaseAdmin
      .from('prediction_models')
      .select('market_key, weights')
      .eq('sport', 'football').eq('active', true);
    modelCache = new Map((data || []).map(r => [r.market_key, r.weights]));
  } catch { modelCache = new Map(); }
  modelCacheAt = Date.now();
  return modelCache;
}

// Perfil de equipo → { all:{metric:{shrunk_value,sample_n,consistency}}, home, away, comp:.., phase:.. }.
async function loadTeamProfile(teamId) {
  if (!teamId) return {};
  try {
    const { data } = await supabaseAdmin
      .from('team_market_profiles')
      .select('metric, segment, sample_n, shrunk_value, consistency')
      .eq('sport', 'football').eq('team_id', teamId);
    const map = {};
    for (const r of (data || [])) {
      (map[r.segment] = map[r.segment] || {})[r.metric] = { shrunk_value: r.shrunk_value, sample_n: r.sample_n, consistency: r.consistency };
    }
    return map;
  } catch { return {}; }
}

/**
 * Recalibra probs con el meta-modelo donde haya mercado activo. Muta probs en
 * sitio (cada lado) y añade probs.confidence = { market: score } + lista
 * probs.contextualMarkets. No-op si está deshabilitado o sin modelos.
 */
export async function calibrateContextual(probs, analysis) {
  const fixtureId = analysis?.fixtureId ?? '?';
  // contextual_status: applied | flag_off | no_models_loaded | error
  const setStatus = (s, extra) => { if (probs) probs.meta = { ...(probs.meta || {}), contextual_status: s, ...(extra || {}) }; };

  console.log('[contextual] entry: flag=%s, fixture=%s', process.env.CONTEXTUAL_MODEL_ENABLED, String(fixtureId));

  if (!enabled()) { console.log('[contextual] flag OFF → no-op, fallback isotónica'); setStatus('flag_off'); return probs; }
  if (!probs || !analysis) { console.log('[contextual] sin probs/analysis → skip'); return probs; }

  let models;
  try { models = await loadActiveModels(); }
  catch (e) { console.error('[contextual] error cargando modelos:', e.message); setStatus('error', { error: e.message }); return probs; }
  if (!models.size) { console.log('[contextual] no_models_loaded (prediction_models sin filas active) → fallback isotónica'); setStatus('no_models_loaded'); return probs; }
  console.log('[contextual] modelos activos cargados: %d', models.size);

  try {
    const homeId = analysis.homeId, awayId = analysis.awayId;
    const [homeProfile, awayProfile] = await Promise.all([loadTeamProfile(homeId), loadTeamProfile(awayId)]);
    const featuresFull = buildFeatureSnapshot(analysis, probs);
    const meetings = (analysis.h2h || []).map(m => meetingRecord(m, null)).filter(Boolean);
    const todayCtx = {
      knockout: !!featuresFull.competition?.isKnockout,
      keyInjury: ((featuresFull.state?.home?.injuryCount || 0) + (featuresFull.state?.away?.injuryCount || 0)) > 0,
      rotationRisk: 0, earlyRedRisk: 0,
    };

    probs.confidence = probs.confidence || {};
    const applied = [];
    for (const [market, weights] of models) {
      try {
        const def = MARKET_DEFS[market];
        if (!def || typeof def.setProb !== 'function') { console.log('[contextual] market=%s: sin def/setProb → skip', market); continue; }
        const h2h = h2hForMarket(meetings, market, homeId, awayId, null);
        let ruptureToday = 0;
        if (h2h.exceptions.length && (todayCtx.knockout || todayCtx.keyInjury)) {
          ruptureToday = rupturePresentToday({ knockout: true, keyInjury: true }, todayCtx);
        }
        const causal = { exceptionRate: h2h.n ? h2h.exceptions.length / h2h.n : null, ruptureToday, rotationRisk: 0 };
        const mf = buildMetaFeatures({ featuresFull, predictionsFull: probs, homeProfile, awayProfile, market, h2h, causal });
        if (!mf) { console.log('[contextual] market=%s: sin base (prob nula) → fallback isotónica', market); continue; }
        const p = predictWithModel(weights, mf.features);
        if (p == null || !isFinite(p)) { console.log('[contextual] market=%s: predict no finito → fallback', market); continue; }
        const pct = Math.max(5, Math.min(95, Math.round(p * 100)));
        def.setProb(probs, pct);
        const support = Math.min(mf.support || 0, 20) / 20;
        const conf = Math.max(0, Math.min(1, 0.4 * support + 0.3 * Math.min(h2h.n, 5) / 5 + 0.3 * (mf.profileAvailable ? 1 : 0) - 0.5 * ruptureToday));
        probs.confidence[market] = Math.round(conf * 100);
        applied.push(market);
        console.log('[contextual] market=%s: model found, applying → %d%% (conf %d, h2h_n %d)', market, pct, probs.confidence[market], h2h.n);
      } catch (e) {
        console.error('[contextual] market=%s: error, fallback to isotonic: %s', market, e.message);
      }
    }
    probs.contextualMarkets = applied;
    probs.model_version = `${probs.model_version || 'dc-v1'}+ctx`;
    setStatus('applied', { applied_count: applied.length });
    console.log('[contextual] APPLIED fixture=%s: %d/%d mercados → %s', String(fixtureId), applied.length, models.size, applied.join(',') || '(ninguno)');
    return probs;
  } catch (e) {
    console.error('[contextual] error general, fallback isotónica:', e.message);
    setStatus('error', { error: e.message });
    return probs;
  }
}

export function _resetContextualCache() { modelCache = null; modelCacheAt = 0; }
