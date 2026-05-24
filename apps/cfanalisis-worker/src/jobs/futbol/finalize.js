// @ts-nocheck
/**
 * Job: futbol-finalize
 * Port of /api/cron/finalize. Two-pass finalizer:
 *   Pass 1: Redis (fast, no API calls).
 *   Pass 2: Supabase fallback — finds unfinalized predictions older than 2h
 *           and reconciles them via match_results or API fetch.
 *
 * Payload: {} (none)
 */
import { redisGet, KEYS, supabaseAdmin, pgQuery } from '../../shared.js';
import { mapPool } from '../../pool.js';

const FINALIZE_CONCURRENCY = 10;

const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];
const API_HOST = 'v3.football.api-sports.io';

async function apiGet(path, apiKey) {
  const res = await fetch(`https://${API_HOST}${path}`, {
    headers: { 'x-apisports-key': apiKey },
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.response || null;
}

async function fetchFixture(fid, apiKey) {
  const resp = await apiGet(`/fixtures?id=${fid}`, apiKey);
  const match = Array.isArray(resp) ? resp[0] : null;
  if (!match) return null;

  // Fallback ligas exóticas: si statistics viene vacío en la respuesta
  // principal, ir al endpoint dedicado /fixtures/statistics?fixture=X que SÍ
  // tiene corners/cards/shots para esas ligas. Crítico para que la calibración
  // isotónica se alimente correctamente (sin esto, Ucrania/China/Serbia
  // quedaban con corners=0 perpetuo y nunca contribuían al entrenamiento).
  if (!Array.isArray(match.statistics) || match.statistics.length === 0) {
    const dedicated = await apiGet(`/fixtures/statistics?fixture=${fid}`, apiKey);
    if (Array.isArray(dedicated) && dedicated.length > 0) {
      match.statistics = dedicated;
      console.log(`[finalize] stats rescue via /fixtures/statistics for fid=${fid}`);
    }
  }
  return match;
}

// getStat con normalización flexible — API-Football varía nombres entre ligas
// ("Corner Kicks" vs "Corners", "Yellow Cards" vs "Yellowcards"). Si value
// es la cadena "null" o vacía, también devolvemos null (no string truthy).
function getStat(statsObj, ...candidates) {
  const arr = statsObj?.statistics;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const norm = s => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
  const wanted = candidates.map(norm);
  for (const s of arr) {
    if (wanted.includes(norm(s.type))) {
      const v = s.value;
      if (v === null || v === undefined || v === 'null' || v === '') return null;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

function extractResult(match) {
  const homeId = match.teams.home.id;
  const awayId = match.teams.away.id;
  const homeStats = (match.statistics || []).find(s => s.team?.id === homeId);
  const awayStats = (match.statistics || []).find(s => s.team?.id === awayId);
  const goalEvents = (match.events || []).filter(e => e.type === 'Goal' && e.detail !== 'Missed Penalty');
  const cardEvents = (match.events || []).filter(e => e.type === 'Card');

  const statusShort = match.fixture?.status?.short ?? null;
  const hGoals = match.goals?.home ?? null;
  const aGoals = match.goals?.away ?? null;

  // FULLTIME = marcador a 90 min (sin AET). Las casas apuestas pagan a 90min.
  // Si match.score.fulltime existe lo usamos; si no, asumimos goals === fulltime
  // (partidos normales FT).
  const ftHome = match.score?.fulltime?.home ?? hGoals;
  const ftAway = match.score?.fulltime?.away ?? aGoals;

  const hCorners = getStat(homeStats, 'Corner Kicks', 'Corners', 'Corner') ?? 0;
  const aCorners = getStat(awayStats, 'Corner Kicks', 'Corners', 'Corner') ?? 0;

  const yh = getStat(homeStats, 'Yellow Cards', 'Yellowcards');
  const ya = getStat(awayStats, 'Yellow Cards', 'Yellowcards');
  const rh = getStat(homeStats, 'Red Cards', 'Redcards');
  const ra = getStat(awayStats, 'Red Cards', 'Redcards');
  const fromStats = [yh, ya, rh, ra].some(v => v != null);
  const totalCards = fromStats
    ? (yh || 0) + (ya || 0) + (rh || 0) + (ra || 0)
    : cardEvents.length;

  // Stats nuevos para calibracion full (Shots, SoT, Fouls, Offsides)
  const hShots   = getStat(homeStats, 'Total Shots')   ?? null;
  const aShots   = getStat(awayStats, 'Total Shots')   ?? null;
  const hSot     = getStat(homeStats, 'Shots on Goal') ?? null;
  const aSot     = getStat(awayStats, 'Shots on Goal') ?? null;
  const hFouls   = getStat(homeStats, 'Fouls')         ?? null;
  const aFouls   = getStat(awayStats, 'Fouls')         ?? null;
  const hOffside = getStat(homeStats, 'Offsides')      ?? null;
  const aOffside = getStat(awayStats, 'Offsides')      ?? null;

  const goalMinutes = goalEvents
    .map(e => (e.time?.elapsed != null ? e.time.elapsed + (e.time.extra || 0) : null))
    .filter(m => m != null)
    .sort((a, b) => a - b);
  const firstGoalMinute = goalMinutes.length > 0 ? goalMinutes[0] : null;

  const goalScorers = goalEvents.map(e => ({
    player_id: e.player?.id ?? null,
    name: e.player?.name ?? null,
    team_id: e.team?.id ?? null,
    minute: e.time?.elapsed != null ? e.time.elapsed + (e.time.extra || 0) : null,
    detail: e.detail || null,
  }));

  // Construir actuals_full — JSON unificado con TODO lo necesario para
  // calibrar cualquier mercado en build-calibration.js. Distinguimos
  // valores "90min" (fulltime, lo que paga el bookmaker) de "AET" (incluye
  // prorroga). Casas pagan a 90min, asi que para calibracion correcta de
  // over/under usamos goals.totalFt no goals.total.
  const actualsFull = {
    status: statusShort,                          // FT / AET / PEN
    result:
      ftHome === null || ftAway === null
        ? null
        : ftHome > ftAway ? 'H' : ftHome < ftAway ? 'A' : 'D',
    goals: {
      home:    ftHome,
      away:    ftAway,
      total:   ftHome !== null && ftAway !== null ? ftHome + ftAway : null,
      btts:    ftHome !== null && ftAway !== null ? (ftHome > 0 && ftAway > 0) : null,
      // Datos AET incluyendo prorroga (informativo, NO usado para over/under)
      homeAet:  hGoals,
      awayAet:  aGoals,
      totalAet: hGoals !== null && aGoals !== null ? hGoals + aGoals : null,
    },
    corners: {
      home:  hCorners,
      away:  aCorners,
      total: hCorners + aCorners,
    },
    cards: {
      yellowHome: yh ?? null,
      yellowAway: ya ?? null,
      redHome:    rh ?? null,
      redAway:    ra ?? null,
      home:       (yh ?? 0) + (rh ?? 0),
      away:       (ya ?? 0) + (ra ?? 0),
      total:      totalCards,
    },
    shots: {
      home:           hShots,
      away:           aShots,
      total:          hShots !== null && aShots !== null ? hShots + aShots : null,
      onTargetHome:   hSot,
      onTargetAway:   aSot,
      totalOnTarget:  hSot !== null && aSot !== null ? hSot + aSot : null,
    },
    fouls: {
      home:  hFouls,
      away:  aFouls,
      total: hFouls !== null && aFouls !== null ? hFouls + aFouls : null,
    },
    offsides: {
      home:  hOffside,
      away:  aOffside,
      total: hOffside !== null && aOffside !== null ? hOffside + aOffside : null,
    },
    firstGoalMinute,
    goalMinutes,
  };

  // CRITICO: las columnas legacy (actual_result, actual_btts, actual_total_goals)
  // alimentan la calibracion vieja y los reportes financieros. Las casas de
  // apuestas pagan over/under y 1X2 a 90 MIN, NO incluyendo AET. Por eso aqui
  // usamos ftHome/ftAway (score.fulltime) en vez de hGoals/aGoals (que incluyen
  // AET cuando status='AET' o 'PEN'). Sin este fix, AET goals contaminaban el
  // entrenamiento del modelo (over 2.5 marcaba TRUE en un 2-2 ET aunque las
  // casas hubieran pagado UNDER 2.5).
  return {
    homeId, awayId, homeStats, awayStats,
    hGoals: ftHome, aGoals: ftAway,   // legacy: usar FT no goals (NO AET)
    actualResult: ftHome === null ? null : ftHome > ftAway ? 'H' : ftHome < ftAway ? 'A' : 'D',
    actualBtts:   ftHome > 0 && ftAway > 0,
    totalGoals:   ftHome !== null && ftAway !== null ? ftHome + ftAway : null,
    totalCorners: hCorners + aCorners,
    hCorners, aCorners,
    totalCards,
    firstGoalMinute,
    goalMinutes,
    goalScorers,
    goalEvents, cardEvents,
    // Nuevo: payload completo para calibracion JSONB (ya separa FT vs AET)
    actualsFull,
  };
}

// Normaliza el string de API-Football: "M. Oliver, England" -> "M. Oliver".
// Algunos partidos llegan sin pais, otros con; sin normalizar se crean dos
// filas distintas en referee_stats. Tomamos el segmento antes de la coma.
function normalizeRefereeName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.split(',')[0]?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

async function upsertRefereeStats(match, r, dateStr) {
  const refName = normalizeRefereeName(match?.fixture?.referee);
  if (!refName) return;

  const yh = getStat(r.homeStats, 'Yellow Cards') || 0;
  const ya = getStat(r.awayStats, 'Yellow Cards') || 0;
  const rh = getStat(r.homeStats, 'Red Cards') || 0;
  const ra = getStat(r.awayStats, 'Red Cards') || 0;

  // Si no hay datos de tarjetas en statistics, no contabilizamos el partido
  // para el arbitro — preferimos perder una muestra antes que sesgar con ceros.
  if ([yh, ya, rh, ra].every(v => v === 0) && !r.totalCards) return;

  // pgQuery va al VPS Postgres (donde vive referee_stats). NO usar
  // supabaseAdmin.rpc — su .rpc apunta al Supabase real, no a pgAdmin.
  await pgQuery(
    'SELECT increment_referee_stats($1, $2, $3, $4::date)',
    [refName, yh + ya, rh + ra, dateStr]
  );
}

async function upsertMatchResult(fid, date, match, r) {
  return supabaseAdmin.from('match_results').upsert({
    fixture_id:  fid,
    date,
    league_id:   match.league.id,
    league_name: match.league.name,
    home_team:   { id: r.homeId, name: match.teams.home.name, logo: match.teams.home.logo },
    away_team:   { id: r.awayId, name: match.teams.away.name, logo: match.teams.away.logo },
    goals:       match.goals,
    score:       match.score,
    status:      match.fixture.status,
    corners:     { home: r.hCorners, away: r.aCorners, total: r.totalCorners },
    yellow_cards: {
      home: getStat(r.homeStats, 'Yellow Cards'),
      away: getStat(r.awayStats, 'Yellow Cards'),
    },
    red_cards: {
      home: getStat(r.homeStats, 'Red Cards'),
      away: getStat(r.awayStats, 'Red Cards'),
    },
    goal_scorers: r.goalEvents,
    card_events:  r.cardEvents,
    full_data:    match,
  }, { onConflict: 'fixture_id' });
}

async function updatePrediction(fid, r) {
  return supabaseAdmin.from('match_predictions').update({
    // Columnas legacy (compat con queries existentes + calibracion vieja)
    actual_home_goals:        r.hGoals,
    actual_away_goals:        r.aGoals,
    actual_result:            r.actualResult,
    actual_btts:              r.actualBtts,
    actual_total_goals:       r.totalGoals,
    actual_corners:           r.totalCorners || null,
    actual_total_cards:       r.totalCards ?? null,
    actual_first_goal_minute: r.firstGoalMinute ?? null,
    actual_goal_minutes:      r.goalMinutes && r.goalMinutes.length ? r.goalMinutes : null,
    actual_goal_scorers:      r.goalScorers && r.goalScorers.length ? r.goalScorers : null,
    // Nuevo: payload completo para calibracion dinamica de TODOS los mercados
    actuals_full:             r.actualsFull,
    finalized_at:             new Date().toISOString(),
  }).eq('fixture_id', fid);
}

export async function runFinalize(_payload = {}) {
  const apiKey = process.env.FOOTBALL_API_KEY;
  if (!apiKey) throw new Error('FOOTBALL_API_KEY not configured');

  const today     = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  let pass1 = 0, pass2 = 0;
  let apiCalls = 0;
  const errors = [];

  // ── PASS 1 — Redis (fast path, no API calls except for missing results)
  try {
    const liveStats = await redisGet(KEYS.liveStats(today));
    if (liveStats && typeof liveStats === 'object') {
      const finishedFids = Object.entries(liveStats)
        .filter(([, d]) => FINISHED_STATUSES.includes(d.status?.short))
        .map(([fid]) => Number(fid));

      if (finishedFids.length > 0) {
        const { data: existing } = await supabaseAdmin
          .from('match_results').select('fixture_id').in('fixture_id', finishedFids);
        const existingIds = new Set((existing || []).map(r => r.fixture_id));
        const toSave = finishedFids.filter(fid => !existingIds.has(fid));

        const p1Results = await mapPool(toSave, FINALIZE_CONCURRENCY, async (fid) => {
          const match = await fetchFixture(fid, apiKey);
          apiCalls++;
          if (!match) return { fid, status: 'no-match' };
          if (!FINISHED_STATUSES.includes(match.fixture?.status?.short)) return { fid, status: 'not-finished' };

          const r = extractResult(match);
          const { error } = await upsertMatchResult(fid, today, match, r);
          if (error) throw new Error(`upsert: ${error.message || error}`);
          // updatePrediction returns a Promise (async function) — safe to await
          try { await updatePrediction(fid, r); } catch (e) {
            console.warn(`[finalize P1] updatePrediction ${fid}:`, e.message);
          }
          // Acumular tarjetas al arbitro — fallo aqui NO debe romper el finalize
          try { await upsertRefereeStats(match, r, today); } catch (e) {
            console.warn(`[finalize P1] upsertRefereeStats ${fid}:`, e.message);
          }
          return { fid, status: 'finalized' };
        });

        p1Results.forEach((r, idx) => {
          if (!r.ok) {
            errors.push({ pass: 1, fixtureId: toSave[idx], error: r.error.message });
            console.error(`[job:futbol-finalize P1] fixture ${toSave[idx]}:`, r.error.message);
          } else if (r.value.status === 'finalized') {
            pass1++;
          }
        });
      }
    }
  } catch (e) {
    console.error('[job:futbol-finalize P1]', e.message);
    errors.push({ pass: 1, error: e.message });
  }

  // ── PASS 2 — Supabase fallback (catches Redis-expired matches)
  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const { data: unfinalized } = await supabaseAdmin
      .from('match_predictions')
      .select('fixture_id, date')
      .is('finalized_at', null)
      .lt('kickoff', twoHoursAgo)
      .in('date', [today, yesterday]);

    if (unfinalized?.length > 0) {
      const unfinalizedFids = unfinalized.map(r => r.fixture_id);
      const { data: alreadyInResults } = await supabaseAdmin
        .from('match_results')
        .select('fixture_id, goals, score, status, corners, yellow_cards, red_cards, goal_scorers, card_events, date')
        .in('fixture_id', unfinalizedFids);

      const resultsMap = new Map((alreadyInResults || []).map(r => [r.fixture_id, r]));

      const p2Results = await mapPool(unfinalized, FINALIZE_CONCURRENCY, async ({ fixture_id: fid, date }) => {
        const existing = resultsMap.get(fid);

        if (existing) {
          const hGoals = existing.goals?.home ?? null;
          const aGoals = existing.goals?.away ?? null;
          const yc = existing.yellow_cards || {};
          const rc = existing.red_cards || {};
          const totalCards = (yc.home || 0) + (yc.away || 0) + (rc.home || 0) + (rc.away || 0);
          const scorers = Array.isArray(existing.goal_scorers) ? existing.goal_scorers : [];
          const goalMinutes = scorers
            .map(e => (e.time?.elapsed != null ? e.time.elapsed + (e.time.extra || 0) : null))
            .filter(m => m != null)
            .sort((a, b) => a - b);
          const goalScorers = scorers.map(e => ({
            player_id: e.player?.id ?? null,
            name: e.player?.name ?? null,
            team_id: e.team?.id ?? null,
            minute: e.time?.elapsed != null ? e.time.elapsed + (e.time.extra || 0) : null,
            detail: e.detail || null,
          }));
          const r = {
            hGoals, aGoals,
            actualResult: hGoals === null ? null : hGoals > aGoals ? 'H' : hGoals < aGoals ? 'A' : 'D',
            actualBtts:   hGoals > 0 && aGoals > 0,
            totalGoals:   hGoals !== null ? hGoals + aGoals : null,
            totalCorners: existing.corners?.total || null,
            totalCards:   totalCards || null,
            firstGoalMinute: goalMinutes[0] ?? null,
            goalMinutes,
            goalScorers,
          };
          await updatePrediction(fid, r);
          return { fid, status: 'finalized-from-results' };
        }

        const match = await fetchFixture(fid, apiKey);
        apiCalls++;
        if (!match) return { fid, status: 'no-match' };
        if (!FINISHED_STATUSES.includes(match.fixture?.status?.short)) return { fid, status: 'not-finished' };

        const r = extractResult(match);
        const { error } = await upsertMatchResult(fid, date, match, r);
        if (error) throw new Error(`upsert: ${error.message || error}`);
        try { await updatePrediction(fid, r); } catch (e) {
          console.warn(`[finalize P2] updatePrediction ${fid}:`, e.message);
        }
        try { await upsertRefereeStats(match, r, date); } catch (e) {
          console.warn(`[finalize P2] upsertRefereeStats ${fid}:`, e.message);
        }
        return { fid, status: 'finalized-from-api' };
      });

      p2Results.forEach((r, idx) => {
        if (!r.ok) {
          errors.push({ pass: 2, fixtureId: unfinalized[idx].fixture_id, error: r.error.message });
          console.error(`[job:futbol-finalize P2] fixture ${unfinalized[idx].fixture_id}:`, r.error.message);
        } else if (r.value.status?.startsWith('finalized')) {
          pass2++;
        }
      });
    }
  } catch (e) {
    console.error('[job:futbol-finalize P2]', e.message);
    errors.push({ pass: 2, error: e.message });
  }

  return { ok: true, pass1, pass2, apiCalls, errors: errors.length, concurrency: FINALIZE_CONCURRENCY };
}
