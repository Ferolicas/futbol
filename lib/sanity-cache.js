/**
 * sanity-cache.js — REWRITTEN to use Redis + Supabase only (Sanity removed)
 * All previous Sanity calls replaced with Redis (L1) + Supabase (L2).
 */
import { redisGet, redisSet, redisIncr } from './redis';
import { supabaseAdmin } from './supabase';

const FIXTURES_TTL = 2 * 3600;       // 2 hours
const ANALYSIS_TTL = 12 * 3600;      // 12 hours
const ENDPOINT_TTL = 7 * 86400;      // 7 days
const API_COUNT_TTL = 86400;         // 1 day

// ===================== FIXTURES CACHE =====================

export async function getCachedFixtures(date) {
  // L1: Redis
  const cached = await redisGet(`fixtures:${date}`);
  if (cached && Array.isArray(cached) && cached.length > 0) return cached;

  // L2: Supabase
  try {
    const { data } = await supabaseAdmin
      .from('fixtures_cache')
      .select('fixtures, fetched_at')
      .eq('date', date)
      .single();
    if (data?.fixtures) {
      const age = Date.now() - new Date(data.fetched_at).getTime();
      if (age < FIXTURES_TTL * 1000) {
        // Backfill Redis
        redisSet(`fixtures:${date}`, data.fixtures, FIXTURES_TTL).catch(() => {});
        return data.fixtures;
      }
    }
  } catch {}
  return null;
}

export async function getCachedFixturesRaw(date) {
  const r = await redisGet(`fixtures:${date}`);
  if (r && Array.isArray(r) && r.length > 0) return r;
  try {
    const { data } = await supabaseAdmin
      .from('fixtures_cache')
      .select('fixtures')
      .eq('date', date)
      .single();
    return data?.fixtures || null;
  } catch { return null; }
}

export async function cacheFixtures(date, fixtures) {
  // L1: Redis
  await redisSet(`fixtures:${date}`, fixtures, FIXTURES_TTL).catch(() => {});
  // L2: Supabase
  supabaseAdmin.from('fixtures_cache').upsert({
    date,
    fixtures,
    fetched_at: new Date().toISOString(),
  }, { onConflict: 'date' }).then(({ error }) => {
    if (error) console.error('[cacheFixtures]', error.message);
  });
}

// ===================== MATCH ANALYSIS CACHE =====================

// Minimo cache_version aceptado. Subir cuando se rompen contratos del
// payload (nuevos campos en calculatedProbabilities, etc.). Versiones
// previas se ignoran y se re-analizan al primer hit.
const MIN_CACHE_VERSION = 9;

export async function getCachedAnalysis(fixtureId, requestDate, { strict } = {}) {
  const key = `analysis:fixture:${fixtureId}`;
  // L1: Redis
  const cached = await redisGet(key);
  if (cached) {
    const unwrapped = unwrapDoc(cached);
    // Rechazar caches viejos (v<8 no tienen los mercados nuevos: shots, fouls,
    // halfGoals, halfWinner, asianHandicap, mostCorners, mostShots, mostFouls).
    const ver = unwrapped?.cacheVersion || 0;
    if (ver < MIN_CACHE_VERSION) return null;
    const today = requestDate || new Date().toISOString().split('T')[0];
    if (unwrapped.date === today) return unwrapped;
    const yesterday = new Date(new Date(today).getTime() - 86400000).toISOString().split('T')[0];
    if (unwrapped.date === yesterday) return unwrapped;
    return null;
  }

  // L2: Supabase
  try {
    const today = requestDate || new Date().toISOString().split('T')[0];
    const yesterday = new Date(new Date(today).getTime() - 86400000).toISOString().split('T')[0];
    const { data } = await supabaseAdmin
      .from('match_analysis')
      .select('*')
      .eq('fixture_id', Number(fixtureId))
      .gte('date', yesterday)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (!data) return null;
    // Mismo check de version que en L1: descartar rows viejos para que
    // analyzeMatch regenere con todos los mercados nuevos.
    if ((data.cache_version || 0) < MIN_CACHE_VERSION) return null;
    // Unwrap: data.analysis may be double-nested { analysis: { homeTeam, ... }, cacheVersion }
    const raw = data.analysis || {};
    const inner = (raw.analysis && typeof raw.analysis === 'object' && (raw.analysis.homeTeam || raw.analysis.kickoff))
      ? raw.analysis
      : raw;
    const doc = {
      ...inner,
      date: String(data.date),
      fixtureId: data.fixture_id,
      // Prefer Supabase top-level columns, fall back to analysis-embedded values
      odds: data.odds || inner.odds || null,
      combinada: data.combinada || inner.combinada || null,
      calculatedProbabilities: data.probabilities || inner.calculatedProbabilities || null,
    };
    if (doc.homeTeam) {
      redisSet(key, doc, ANALYSIS_TTL).catch(() => {});
      return doc;
    }
    return null;
  } catch { return null; }
}

export async function cacheAnalysis(fixtureId, data) {
  const key = `analysis:fixture:${fixtureId}`;
  const payload = { ...data, fixtureId: Number(fixtureId), cacheVersion: 9, fetchedAt: new Date().toISOString() };
  // L1: Redis
  await redisSet(key, payload, ANALYSIS_TTL).catch(() => {});
  // L2: Supabase
  const date = data.date || new Date().toISOString().split('T')[0];
  try {
    await supabaseAdmin.from('match_analysis').upsert({
      fixture_id: Number(fixtureId),
      date,
      analysis: payload,
      odds: data.odds || null,
      combinada: data.combinada || null,
      probabilities: data.calculatedProbabilities || null,
      data_quality: data.dataQuality || 'good',
      cache_version: 9,
    }, { onConflict: 'fixture_id,date' });
  } catch (e) {
    console.error(`[cacheAnalysis] Supabase save failed for ${fixtureId}:`, e.message);
  }
  // Invalidar el indice cacheado de IDs analizados — si no, el primer hit del
  // dashboard (con pocos analizados) deja la lista congelada hasta 1h y el
  // resto del lote ya no aparece en analyzedData.
  redisSet(`analyzed-ids:${date}`, null, 1).catch(() => {});
  return true;
}

// ===================== GENERIC ENDPOINT CACHE (Redis only) =====================

export async function getCachedEndpoint(cacheKey) {
  const cached = await redisGet(`api:${cacheKey}`);
  return cached ?? null;
}

export async function cacheEndpoint(cacheKey, data) {
  await redisSet(`api:${cacheKey}`, data, ENDPOINT_TTL).catch(() => {});
}

// ===================== API CALL COUNTER =====================

export async function getApiCallCount() {
  const today = new Date().toISOString().split('T')[0];
  const count = await redisGet(`apicalls:${today}`);
  return count !== null ? Number(count) : 0;
}

export async function incrementApiCallCount() {
  const today = new Date().toISOString().split('T')[0];
  const count = await redisIncr(`apicalls:${today}`, API_COUNT_TTL);
  return count !== null ? count : 0;
}

// ===================== ANALYZED MATCHES LIST =====================

export async function getAnalyzedFixtureIds(date) {
  const key = `analyzed-ids:${date}`;
  const cached = await redisGet(key);
  if (cached) return cached;
  try {
    const { data } = await supabaseAdmin
      .from('match_analysis')
      .select('fixture_id')
      .eq('date', date);
    const ids = (data || []).map(r => r.fixture_id);
    if (ids.length > 0) redisSet(key, ids, 3600).catch(() => {});
    return ids;
  } catch { return []; }
}

export async function getAnalyzedOdds(fixtureIds) {
  const results = {};
  const rows = await Promise.all(
    fixtureIds.map(id => redisGet(`analysis:fixture:${id}`))
  );
  rows.forEach((doc, i) => {
    if (doc?.odds?.matchWinner) results[fixtureIds[i]] = doc.odds.matchWinner;
  });

  // Fetch missing from Supabase
  const missing = fixtureIds.filter((_, i) => !rows[i]);
  if (missing.length > 0) {
    try {
      const { data } = await supabaseAdmin
        .from('match_analysis')
        .select('fixture_id, odds')
        .in('fixture_id', missing);
      (data || []).forEach(r => {
        if (r.odds?.matchWinner) results[r.fixture_id] = r.odds.matchWinner;
      });
    } catch {}
  }
  return results;
}

// Unwrap docs saved with wrong structure: { analysis: {...full}, fromCache, apiCalls, ... }
// This was caused by a bug where crons called cacheAnalysis({ ...result }) instead of { ...result.analysis }
function unwrapDoc(doc) {
  if (!doc) return doc;
  if (doc.analysis && typeof doc.analysis === 'object' &&
      (doc.analysis.homeTeam || doc.analysis.odds || doc.analysis.homeLastFive)) {
    const inner = doc.analysis;
    return {
      ...inner,
      fixtureId: inner.fixtureId || doc.fixtureId,
      date: inner.date || doc.date,
    };
  }
  return doc;
}

export async function getAnalyzedMatchesFull(fixtureIds) {
  if (!fixtureIds || fixtureIds.length === 0) return { analyzedOdds: {}, analyzedData: {} };

  // L1: Redis parallel
  const cached = await Promise.all(fixtureIds.map(id => redisGet(`analysis:fixture:${id}`)));
  const analyzedOdds = {};
  const analyzedData = {};
  const missingIds = [];

  cached.forEach((doc, i) => {
    if (doc) {
      const unwrapped = unwrapDoc(doc);
      if (unwrapped.odds?.matchWinner) analyzedOdds[fixtureIds[i]] = unwrapped.odds.matchWinner;
      analyzedData[fixtureIds[i]] = extractAnalysisFields(unwrapped);
    } else {
      missingIds.push(fixtureIds[i]);
    }
  });

  // L2: Supabase for missing
  if (missingIds.length > 0) {
    try {
      const { data } = await supabaseAdmin
        .from('match_analysis')
        .select('fixture_id, analysis, odds, combinada, probabilities, date')
        .in('fixture_id', missingIds)
        .order('created_at', { ascending: false });

      const seen = new Set();
      (data || []).forEach(row => {
        if (seen.has(row.fixture_id)) return;
        seen.add(row.fixture_id);
        // Unwrap wrong nested structure from Supabase too
        const rawAnalysis = row.analysis || {};
        const inner = (rawAnalysis.analysis && typeof rawAnalysis.analysis === 'object' &&
          (rawAnalysis.analysis.homeTeam || rawAnalysis.analysis.odds))
          ? rawAnalysis.analysis
          : rawAnalysis;
        const doc = {
          ...inner,
          // Prefer Supabase top-level columns; fall back to nested analysis data
          odds: row.odds || inner.odds,
          combinada: row.combinada || inner.combinada,
          calculatedProbabilities: row.probabilities || inner.calculatedProbabilities,
          fixtureId: row.fixture_id,
          date: String(row.date),
        };
        if (doc.odds?.matchWinner) analyzedOdds[row.fixture_id] = doc.odds.matchWinner;
        analyzedData[row.fixture_id] = extractAnalysisFields(doc);
        // Backfill Redis with unwrapped correct doc
        redisSet(`analysis:fixture:${row.fixture_id}`, doc, ANALYSIS_TTL).catch(() => {});
      });
    } catch (e) {
      console.error('[getAnalyzedMatchesFull] Supabase error:', e.message);
    }
  }

  return { analyzedOdds, analyzedData };
}

function compactLastFive(lastFive) {
  if (!Array.isArray(lastFive)) return [];
  return lastFive.map(m => {
    const e = m._enriched || {};
    return {
      r: e.result,
      s: e.score,
      gF: e.goalsFor,
      gA: e.goalsAgainst,
      op: e.opponentName,
      oL: e.opponentLogo,
      c: e.corners,
      y: e.yellowCards,
      rd: e.redCards,
    };
  });
}

function extractAnalysisFields(doc) {
  return {
    fixtureId: doc.fixtureId, homeTeam: doc.homeTeam, awayTeam: doc.awayTeam,
    homeLogo: doc.homeLogo, awayLogo: doc.awayLogo, homeId: doc.homeId, awayId: doc.awayId,
    league: doc.league, leagueId: doc.leagueId, leagueLogo: doc.leagueLogo,
    kickoff: doc.kickoff, status: doc.status, goals: doc.goals,
    odds: doc.odds, combinada: doc.combinada,
    calculatedProbabilities: doc.calculatedProbabilities || doc.probabilities,
    homePosition: doc.homePosition, awayPosition: doc.awayPosition,
    homeLastFive: compactLastFive(doc.homeLastFive),
    awayLastFive: compactLastFive(doc.awayLastFive),
    playerHighlights: doc.playerHighlights || null,
  };
}

export async function markAsAnalyzed(date, fixtureId) {
  // Just invalidate the analyzed-ids Redis key so next fetch re-reads from Supabase
  await redisSet(`analyzed-ids:${date}`, null, 1).catch(() => {});
}

export async function getAnalyzedMatchesData(fixtureIds) {
  const { analyzedData } = await getAnalyzedMatchesFull(fixtureIds);
  return analyzedData;
}

export async function getAllStandingsFromCache(leagueIds) {
  const positions = {};
  const results = await Promise.all(
    leagueIds.map(lid => {
      const year = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;
      return getCachedEndpoint(`standings-${lid}-${year}`).catch(() => null);
    })
  );
  results.forEach(cached => {
    if (cached?.[0]?.league?.standings) {
      const table = cached[0].league.standings.flat();
      for (const entry of table) {
        if (entry.team?.id) positions[entry.team.id] = entry.rank;
      }
    }
  });
  return positions;
}
