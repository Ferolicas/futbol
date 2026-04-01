/**
 * Supabase cache layer — replaces sanity-cache.js for app data.
 * Sanity is now ONLY for editorial content (blog, landing).
 * App data (fixtures, analysis, config) lives in Supabase + Redis.
 */

import { supabaseAdmin } from './supabase';
import { redisGet, redisSet, KEYS, TTL } from './redis';

// ============================================================
// FIXTURES CACHE
// ============================================================

/**
 * Get fixtures for a date.
 * Layer 1: Redis (instant)
 * Layer 2: Supabase fixtures_cache
 * Returns null if not found.
 */
export async function getFixturesCached(date) {
  // Layer 1: Redis
  const cached = await redisGet(KEYS.fixtures(date));
  if (cached && Array.isArray(cached) && cached.length > 0) {
    return { fixtures: cached, source: 'redis' };
  }

  // Layer 2: Supabase
  const { data, error } = await supabaseAdmin
    .from('fixtures_cache')
    .select('fixtures, fetched_at')
    .eq('date', date)
    .single();

  if (error || !data?.fixtures) return null;

  // Warm Redis cache
  await redisSet(KEYS.fixtures(date), data.fixtures, TTL.yesterday);
  return { fixtures: data.fixtures, source: 'supabase' };
}

/**
 * Save fixtures to both Redis and Supabase.
 */
export async function saveFixturesCached(date, fixtures) {
  // Redis
  await redisSet(KEYS.fixtures(date), fixtures, TTL.yesterday).catch(err =>
    console.error('[supabase-cache:saveFixtures] redis:', err.message)
  );

  // Supabase
  const { error } = await supabaseAdmin
    .from('fixtures_cache')
    .upsert({ date, fixtures, fetched_at: new Date().toISOString() }, { onConflict: 'date' });

  if (error) console.error('[supabase-cache:saveFixtures] supabase:', error.message);
}

// ============================================================
// MATCH ANALYSIS
// ============================================================

/**
 * Get analysis for a fixture.
 * Layer 1: Redis analysisData:{fid}
 * Layer 2: Supabase match_analysis
 */
export async function getAnalysisCached(fixtureId) {
  const redisKey = `analysisData:${fixtureId}`;

  const cached = await redisGet(redisKey);
  if (cached) return { analysis: cached, source: 'redis' };

  const { data, error } = await supabaseAdmin
    .from('match_analysis')
    .select('analysis, odds, combinada, probabilities, data_quality')
    .eq('fixture_id', fixtureId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return null;

  const result = {
    ...data.analysis,
    odds: data.odds,
    combinada: data.combinada,
    probabilities: data.probabilities,
    dataQuality: data.data_quality,
  };

  // Warm Redis
  await redisSet(redisKey, result, TTL.analysis || 26 * 3600).catch(err =>
    console.error('[supabase-cache:getAnalysis] redis warm:', err.message)
  );

  return { analysis: result, source: 'supabase' };
}

/**
 * Save analysis to both Redis and Supabase.
 */
export async function saveAnalysisCached(fixtureId, date, analysisObj) {
  const redisKey = `analysisData:${fixtureId}`;

  // Redis
  await redisSet(redisKey, analysisObj, TTL.analysis || 26 * 3600).catch(err =>
    console.error('[supabase-cache:saveAnalysis] redis:', err.message)
  );

  // Supabase
  const { error } = await supabaseAdmin
    .from('match_analysis')
    .upsert({
      fixture_id: Number(fixtureId),
      date,
      analysis: analysisObj,
      odds: analysisObj.odds || null,
      combinada: analysisObj.combinada || null,
      probabilities: analysisObj.calculatedProbabilities || analysisObj.probabilities || null,
      data_quality: analysisObj.dataQuality || 'good',
    }, { onConflict: 'fixture_id,date' });

  if (error) console.error('[supabase-cache:saveAnalysis] supabase:', error.message);
}

/**
 * Get all analyzed fixture IDs for a date.
 */
export async function getAnalyzedIdsForDate(date) {
  const redisKey = `analyzed-ids:${date}`;

  const cached = await redisGet(redisKey);
  if (cached && Array.isArray(cached)) return cached;

  const { data, error } = await supabaseAdmin
    .from('match_analysis')
    .select('fixture_id')
    .eq('date', date);

  if (error || !data) return [];

  const ids = data.map(r => r.fixture_id);
  await redisSet(redisKey, ids, 4 * 3600).catch(() => {});
  return ids;
}

// ============================================================
// APP CONFIG (replaces Sanity appConfig)
// ============================================================

export async function getAppConfig(key) {
  const { data, error } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', key)
    .single();

  if (error || !data) return null;
  return data.value;
}

export async function setAppConfig(key, value) {
  const { error } = await supabaseAdmin
    .from('app_config')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });

  if (error) console.error('[supabase-cache:setAppConfig]', key, error.message);
}

// ============================================================
// MATCH SCHEDULE
// ============================================================

export async function getMatchSchedule(date) {
  // Redis first
  const cached = await redisGet(`schedule:${date}`);
  if (cached) return cached;

  const { data, error } = await supabaseAdmin
    .from('match_schedule')
    .select('*')
    .eq('date', date)
    .single();

  if (error || !data) return null;

  const schedule = {
    kickoffTimes: data.kickoff_times,
    firstKickoff: data.first_kickoff,
    lastExpectedEnd: data.last_expected_end,
    fixtureCount: data.fixture_count,
  };

  await redisSet(`schedule:${date}`, schedule, 6 * 3600).catch(() => {});
  return schedule;
}

export async function saveMatchSchedule(date, schedule) {
  await redisSet(`schedule:${date}`, schedule, 6 * 3600).catch(() => {});

  const { error } = await supabaseAdmin
    .from('match_schedule')
    .upsert({
      date,
      kickoff_times: schedule.kickoffTimes || [],
      first_kickoff: schedule.firstKickoff || null,
      last_expected_end: schedule.lastExpectedEnd || null,
      fixture_count: schedule.fixtureCount || schedule.kickoffTimes?.length || 0,
    }, { onConflict: 'date' });

  if (error) console.error('[supabase-cache:saveMatchSchedule]', error.message);
}
