import { getQuota, refreshLineups, refreshInjuries, fetchMatchStats, analyzeMatch } from '../../../../lib/api-football';
import { getCachedAnalysis, cacheAnalysis, getCachedFixtures } from '../../../../lib/sanity-cache';
import { redisGet, redisSet, KEYS, TTL } from '../../../../lib/redis';
import { supabaseAdmin } from '../../../../lib/supabase';
import { getCurrentUser } from '../../../../lib/auth-pg';
import { userHasActivePlan } from '../../../../lib/require-active-plan';
import { jsonError } from '../../../../lib/api-error';
import { redisRateLimit } from '../../../../lib/ratelimit-redis';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request, { params }) {
  const { id } = params;
  const { searchParams } = new URL(request.url);
  const clientDate = searchParams.get('date');

  if (!id) {
    return Response.json({ error: 'fixture id required' }, { status: 400 });
  }

  // R8 FIX: contenido premium + acciones que gastan cuota (analyzeMatch inline,
  // refresh-stats/lineups) estaban SIN auth. Exigimos sesión + plan activo o
  // admin (igual que baseball).
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!(await userHasActivePlan(user))) {
    return Response.json({ error: 'Subscription required' }, { status: 403 });
  }

  try {
    let analysis = await getCachedAnalysis(id, clientDate);
    // Regeneración perezosa: si la caché falta o quedó obsoleta (p.ej. tras subir
    // MIN_CACHE_VERSION), re-analizar al vuelo con el fixture cacheado del día en
    // vez de devolver "sin analizar". Así el motor nuevo se aplica al primer acceso.
    if (!analysis) {
      try {
        const date = clientDate || new Date().toISOString().split('T')[0];
        const fixtures = await getCachedFixtures(date);
        const fixture = fixtures?.find(f => f.fixture.id === Number(id));
        if (fixture) {
          const result = await analyzeMatch(fixture, { date });
          const doc = result?.analysis || result;
          if (doc) {
            // analyzeMatch ya persiste internamente. Re-persistimos por visibilidad
            // SOLO si hay datos suficientes: un insufficient ya quedó guardado con
            // combinada vacía y no merece un segundo upsert.
            // (Spread DESANIDADO: combinada/calculatedProbabilities/odds viven en
            // result.analysis.*, no en result.* → { ...doc } las persiste bien.)
            if (result.dataQuality !== 'insufficient') {
              const _cache = await cacheAnalysis(id, { ...doc, date }).catch((e) => {
                console.error('[cacheAnalysis:THREW]', { fixtureId: id, date, error: e.message });
                return { db: false, redis: false };
              });
              if (_cache && _cache.db === false) {
                console.error('[cacheAnalysis:PG_FAILED]', { fixtureId: id, date, error: _cache.error });
              }
            }
            // Mostrar el partido aunque sea insufficient (combinada vacía, sin picks).
            analysis = doc;
          }
        }
      } catch (e) {
        console.error('[match:GET] lazy re-analyze failed:', e.message);
      }
    }
    if (!analysis) {
      return Response.json({ error: 'Match not analyzed yet', notFound: true }, { status: 404 });
    }

    // Merge latest live status from Redis
    const today = clientDate || new Date().toISOString().split('T')[0];
    let statusUpdated = false;

    try {
      const liveData = await redisGet(KEYS.liveStats(today));
      if (liveData?.[id]) {
        const live = liveData[id];
        if (live.status?.short && live.status.short !== analysis.status?.short) {
          analysis.status = live.status;
          analysis.goals = live.goals || analysis.goals;
          statusUpdated = true;
        }
      }
    } catch {}

    if (!statusUpdated) {
      try {
        const stats = await redisGet(KEYS.fixtureStats(id));
        if (stats?.status?.short && stats.status.short !== analysis.status?.short) {
          analysis.status = stats.status;
          analysis.goals = stats.goals || analysis.goals;
          statusUpdated = true;
        }
      } catch {}
    }

    if (!statusUpdated && clientDate) {
      try {
        const fixtures = await getCachedFixtures(clientDate);
        if (fixtures) {
          const fresh = fixtures.find(f => f.fixture.id === Number(id));
          if (fresh?.fixture?.status?.short && fresh.fixture.status.short !== analysis.status?.short) {
            analysis.status = fresh.fixture.status;
            analysis.goals = fresh.goals || analysis.goals;
          }
        }
      } catch {}
    }

    const quota = await getQuota();
    return Response.json({ analysis, quota });
  } catch (error) {
    console.error('[match:GET]', error.message);
    return jsonError(error);
  }
}

// POST: refresh lineups or injuries
export async function POST(request, { params }) {
  const { id } = params;
  // R8 FIX: las acciones analyze/refresh-stats/refresh-lineups gastan cuota
  // API-Football → exigir sesión + plan activo o admin (igual que baseball).
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!(await userHasActivePlan(user))) {
    return Response.json({ error: 'Subscription required' }, { status: 403 });
  }
  // BE-2: rate-limit por usuario en acciones que queman cuota API-Football/CPU.
  const rl = await redisRateLimit('match-action', user.id, 20, 60);
  if (!rl.success) {
    return Response.json({ error: 'Demasiadas solicitudes. Espera un momento.' }, { status: 429 });
  }
  const { action, date } = await request.json();

  try {
    if (action === 'refresh-lineups') {
      const lineups = await refreshLineups(id);
      const quota = await getQuota();

      // Persist lineups into the cached analysis
      if (lineups.available) {
        const existing = await getCachedAnalysis(id, date);
        if (existing) {
          // A-2 FIX: captar db:false y excepción (antes sin catch; un fallo de
          // PG quedaba invisible). El usuario sigue recibiendo los lineups.
          const _cache = await cacheAnalysis(id, { ...existing, lineups }).catch((e) => {
            console.error('[cacheAnalysis:THREW]', { fixtureId: id, date, error: e.message });
            return { db: false, redis: false };
          });
          if (_cache && _cache.db === false) {
            console.error('[cacheAnalysis:PG_FAILED]', { fixtureId: id, date, error: _cache.error });
          }
        }
      }

      return Response.json({ lineups, quota });
    }

    if (action === 'refresh-injuries') {
      const injuries = await refreshInjuries(id);
      const quota = await getQuota();
      return Response.json({ injuries, quota });
    }

    if (action === 'refresh-stats') {
      // L1: Check Redis — return if stats present OR if we already attempted a fetch (savedAt flag).
      // The savedAt flag means we've already called the API for this fixture (possibly a lower-league
      // match with no stats). Without this guard, every page load would re-call the API for the same
      // empty-stats fixture and waste quota.
      const cached = await redisGet(KEYS.fixtureStats(id));
      const hasStats = cached && (
        (cached.corners?.total > 0) ||
        (cached.yellowCards?.total > 0) ||
        (cached.goalScorers?.length > 0) ||
        (cached.cardEvents?.length > 0)
      );
      if (hasStats || cached?.savedAt) {
        return Response.json({ stats: cached, fromCache: true });
      }

      // L2: Check Supabase (permanent storage)
      try {
        const { data: row } = await supabaseAdmin
          .from('match_analysis')
          .select('live_stats')
          .eq('fixture_id', Number(id))
          .not('live_stats', 'is', null)
          .limit(1)
          .single();
        if (row?.live_stats && (row.live_stats.corners || row.live_stats.yellowCards || row.live_stats.goalScorers?.length)) {
          // Backfill Redis
          redisSet(KEYS.fixtureStats(id), row.live_stats, TTL.yesterday).catch(() => {});
          return Response.json({ stats: row.live_stats, fromCache: true });
        }
      } catch {}

      // L3: Fetch from API
      const stats = await fetchMatchStats(id);
      if (!stats) return Response.json({ error: 'Match not found' }, { status: 404 });

      await redisSet(KEYS.fixtureStats(id), stats, TTL.yesterday);
      // Persist to Supabase permanently
      try {
        await supabaseAdmin.from('match_analysis')
          .update({ live_stats: stats })
          .eq('fixture_id', Number(id));
      } catch (e) { console.error(`[match:refresh-stats] Supabase save ${id}:`, e.message); }
      const quota = await getQuota();
      return Response.json({ stats, quota });
    }

    if (action === 'analyze') {
      // On-demand analysis for a single fixture
      const fixtures = await getCachedFixtures(date);
      if (!fixtures || fixtures.length === 0) {
        return Response.json({ error: 'No fixtures cached for this date. Try again later.' }, { status: 404 });
      }
      const fixture = fixtures.find(f => f.fixture.id === Number(id));
      if (!fixture) {
        return Response.json({ error: 'Fixture not found in cache for this date.' }, { status: 404 });
      }
      const result = await analyzeMatch(fixture, { date });
      if (!result || result.dataQuality === 'insufficient') {
        return Response.json({ error: 'Insufficient data to analyze this match.' }, { status: 422 });
      }
      // A-2 FIX: visibilidad si la persistencia a PG falla (se sigue sirviendo
      // desde Redis, pero sin esto desaparece al expirar el TTL).
      // POR QUÉ FALLABA: analyzeMatch devuelve { analysis, fromCache, apiCalls,
      // persist }. combinada/calculatedProbabilities/odds viven en result.analysis.*,
      // NO en result.*. Con `{ ...result }`, cacheAnalysis leía data.combinada=
      // undefined → columnas combinada/probabilities a NULL y JSON doble-anidado
      // (el caso de 1546805). Se persiste el doc DESANIDADO (result.analysis).
      const _cache = await cacheAnalysis(id, { ...(result.analysis || result), date }).catch((e) => {
        console.error('[cacheAnalysis:THREW]', { fixtureId: id, date, error: e.message });
        return { db: false, redis: false };
      });
      if (_cache && _cache.db === false) {
        console.error('[cacheAnalysis:PG_FAILED]', { fixtureId: id, date, error: _cache.error });
      }
      const quota = await getQuota();
      return Response.json({ analysis: result.analysis || result, quota });
    }

    return Response.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('[match:POST]', error.message);
    return jsonError(error);
  }
}
