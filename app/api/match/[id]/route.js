import {
  getQuota, refreshLineups, refreshInjuries, fetchMatchStats, analyzeMatch,
  recomputeAnalysisWithConfirmedLineups,
} from '../../../../lib/api-football';
import { getCachedAnalysis, cacheAnalysis, getCachedFixtures } from '../../../../lib/sanity-cache';
import { redisGet, redisSet, KEYS, TTL } from '../../../../lib/redis';
import { supabaseAdmin } from '../../../../lib/supabase';
import { getCurrentUser } from '../../../../lib/auth-pg';
import { userHasActivePlan } from '../../../../lib/require-active-plan';
import { jsonError } from '../../../../lib/api-error';
import { redisRateLimit } from '../../../../lib/ratelimit-redis';
import footballResultSnapshot from '../../../../lib/football-result-snapshot.cjs';

const {
  buildDurableResultSnapshot,
  mergeDurableResultWithLive,
} = footballResultSnapshot;

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
            if (!result.fromCache && result.persist?.db === false) {
              console.error('[cacheAnalysis:PG_FAILED]', {
                fixtureId: id, date, error: result.persist?.error,
              });
            }
            // Sin datos también es un análisis válido: se muestra sin picks.
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

    // match_results es la autoridad durable de un partido cerrado. Redis live
    // expira y match_analysis puede no tener estadísticas en ligas de cobertura
    // limitada; el marcador/goles disponibles nunca deben desaparecer por eso.
    let durableResult = null;
    try {
      const { data: resultRow } = await supabaseAdmin
        .from('match_results')
        .select('fixture_id,status,goals,score,corners,yellow_cards,red_cards,goal_scorers,card_events,created_at')
        .eq('fixture_id', Number(id))
        .maybeSingle();
      durableResult = buildDurableResultSnapshot(resultRow);
    } catch (e) {
      console.error('[match:GET] durable result lookup failed:', e.message);
    }

    // Merge latest live status from Redis. Si existe cierre durable, este gana
    // en status/marcador y Redis solo puede aportar campos reales adicionales.
    const today = clientDate || new Date().toISOString().split('T')[0];
    let statusUpdated = false;
    let resultStats = durableResult;

    try {
      const liveData = await redisGet(KEYS.liveStats(today));
      if (liveData?.[id]) {
        const live = liveData[id];
        resultStats = durableResult
          ? mergeDurableResultWithLive(durableResult, live)
          : live;
        if (resultStats.status?.short && resultStats.status.short !== analysis.status?.short) {
          analysis.status = resultStats.status;
          analysis.goals = resultStats.goals || analysis.goals;
          analysis.score = resultStats.score || analysis.score;
          statusUpdated = true;
        }
      }
    } catch {}

    if (!statusUpdated) {
      try {
        const stats = await redisGet(KEYS.fixtureStats(id));
        if (stats) {
          resultStats = durableResult
            ? mergeDurableResultWithLive(durableResult, stats)
            : stats;
        }
        if (resultStats?.status?.short && resultStats.status.short !== analysis.status?.short) {
          analysis.status = resultStats.status;
          analysis.goals = resultStats.goals || analysis.goals;
          analysis.score = resultStats.score || analysis.score;
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

    // Última palabra: un cache NS/live nunca puede degradar un resultado final
    // confirmado en PostgreSQL.
    if (durableResult) {
      analysis.status = durableResult.status;
      analysis.goals = durableResult.goals || analysis.goals;
      analysis.score = durableResult.score || analysis.score;
      resultStats = resultStats
        ? mergeDurableResultWithLive(durableResult, resultStats)
        : durableResult;
    }

    const quota = await getQuota();
    return Response.json({ analysis, resultStats, quota });
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
          const targetDate = date || existing.date || new Date().toISOString().split('T')[0];
          const fixtures = await getCachedFixtures(targetDate);
          const fixture = fixtures?.find((item) => item.fixture?.id === Number(id));
          const updated = fixture
            ? await recomputeAnalysisWithConfirmedLineups(fixture, existing, lineups.data)
            : { ...existing, lineups };
          // A-2 FIX: captar db:false y excepción (antes sin catch; un fallo de
          // PG quedaba invisible). El usuario sigue recibiendo los lineups.
          const _cache = await cacheAnalysis(id, updated).catch((e) => {
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

      // L2: resultado final durable. Incluso si la liga solo entregó goles o
      // tarjetas, lo disponible se devuelve y no se vuelve a gastar cuota
      // intentando fabricar mercados que el proveedor no cubre.
      try {
        const { data: resultRow } = await supabaseAdmin
          .from('match_results')
          .select('fixture_id,status,goals,score,corners,yellow_cards,red_cards,goal_scorers,card_events,created_at')
          .eq('fixture_id', Number(id))
          .maybeSingle();
        const resultStats = buildDurableResultSnapshot(resultRow);
        if (resultStats) {
          redisSet(KEYS.fixtureStats(id), resultStats, TTL.yesterday).catch(() => {});
          return Response.json({ stats: resultStats, fromCache: true });
        }
      } catch (e) {
        console.error(`[match:refresh-stats] durable result ${id}:`, e.message);
      }

      // L3: almacenamiento permanente del análisis (compatibilidad histórica)
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

      // L4: Fetch from API
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
      if (!result) {
        return Response.json({ error: 'No fue posible analizar este partido.' }, { status: 422 });
      }
      if (!result.fromCache && result.persist?.db === false) {
        console.error('[cacheAnalysis:PG_FAILED]', {
          fixtureId: id, date, error: result.persist?.error,
        });
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
