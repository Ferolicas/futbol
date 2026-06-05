// @ts-nocheck
/**
 * Job: futbol-finalize
 *
 * Cierra los resultados de los partidos del día leyendo la lista de fixtures de
 * `match_schedule` (NO del bucket Redis efímero `live:*`, que tenía TTL 2h y
 * vivía bajo la fecha-UTC equivocada → perdía casi todos los partidos de la
 * tarde/noche; anoche finalizó 1 de 6). Patrón calcado de baseball-finalize:
 * lista pendiente desde una tabla → agrupar por fecha → 1 llamada /fixtures?id=X
 * por partido. Sin dependencia de Redis ni de `match_predictions` (tabla muerta).
 *
 * Flujo:
 *   1. Resolver fecha(s) objetivo. El cron corre de madrugada España (03/04),
 *      que en Bogotá es aún la noche de la jornada que acaba de terminar, así
 *      que bogotaToday() ES esa jornada. Por defecto procesa esa jornada + la
 *      anterior (red de seguridad para lo que no finalizó la corrida previa).
 *      payload.date fuerza una fecha concreta; payload.includeNext añade la
 *      jornada siguiente (partidos de Asia/Oceanía que ya terminaron temprano).
 *   2. Sacar los fixtureId de kickoff_times de la fila de cada fecha.
 *   3. Saltar los que ya están en match_results (dedup → 0 llamadas API).
 *   4. /fixtures?id=X por cada uno; solo FT/AET/PEN se finalizan. La API
 *      devuelve el resultado COMPLETO; nada se filtra a mano (match_results
 *      guarda full_data = payload entero, y raw_api_payloads el crudo por
 *      endpoint), así que ningún mercado se omite por no haberlo pedido.
 *   5. Upsert a match_results + referee_stats + halfstats. Luego
 *      captureFinalizedFixturesRaw nutre raw_api_payloads (fixture detalle +
 *      statistics/events/lineups/injuries).
 *
 * Payload: { date?: 'YYYY-MM-DD', includeNext?: boolean }
 */
import {
  supabaseAdmin,
  pgQuery,
  getMatchSchedule,
  captureFinalizedFixturesRaw,
  bogotaToday,
} from '../../shared.js';
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

// ── Snapshot de stats por mitad (durable) ────────────────────────────────────
// El live captura el total de la 1ª parte en el tick de HT (payload.firstHalf).
// Aquí, al finalizar, escribimos el total a 90' (fullTime) y derivamos la 2ª
// parte (fullTime − firstHalf) para córners/tiros/faltas/offsides, que la API
// nunca da con minuto. Goles/tarjetas de 1ª parte se derivan de datos CON minuto
// (score.halftime / eventos) → autoritativos aunque el live no capturara el HT.
// Merge jsonb (||): conserva el firstHalf del live y añade lo de aquí.
async function persistHalfStatsFull(fid, match, r) {
  const af = r.actualsFull || {};
  const pick = (o) => (o && o.total != null) ? { home: o.home ?? null, away: o.away ?? null, total: o.total } : null;
  const ft = {
    goals:    pick(af.goals),
    corners:  pick(af.corners),
    shots:    pick(af.shots),
    sot:      (af.shots && af.shots.totalOnTarget != null)
                ? { home: af.shots.onTargetHome ?? null, away: af.shots.onTargetAway ?? null, total: af.shots.totalOnTarget } : null,
    fouls:    pick(af.fouls),
    offsides: pick(af.offsides),
    cards:    pick(af.cards),
  };
  // 1ª parte autoritativa de goles (score.halftime) y tarjetas (eventos ≤45').
  const ht = match.score?.halftime || {};
  const goals1H = (ht.home != null && ht.away != null)
    ? { home: ht.home, away: ht.away, total: ht.home + ht.away } : null;
  const ce = r.cardEvents || [];
  const cards1H = ce.length
    ? (() => {
        const inFirst = (e) => (e.time?.elapsed ?? 99) <= 45;
        const h = ce.filter(e => e.team?.id === r.homeId && inFirst(e)).length;
        const a = ce.filter(e => e.team?.id === r.awayId && inFirst(e)).length;
        return { home: h, away: a, total: h + a };
      })()
    : null;

  // firstHalf capturado por el live (córners/tiros/faltas/offsides de la 1ª parte).
  let firstHalf = null;
  try {
    const { rows } = await pgQuery(
      `SELECT payload FROM raw_api_payloads WHERE endpoint='fixtures/halfstats' AND ref_id=$1 AND sub_key=''`,
      [fid]);
    firstHalf = rows?.[0]?.payload?.firstHalf || null;
  } catch {}

  const sub = (full, first) =>
    (full && first && full.total != null && first.total != null)
      ? { home: (full.home ?? 0) - (first.home ?? 0), away: (full.away ?? 0) - (first.away ?? 0), total: full.total - first.total }
      : null;
  const secondHalf = {
    goals:    sub(ft.goals, goals1H),
    cards:    sub(ft.cards, cards1H),
    corners:  firstHalf ? sub(ft.corners,  firstHalf.corners)  : null,
    shots:    firstHalf ? sub(ft.shots,    firstHalf.shots)    : null,
    sot:      firstHalf ? sub(ft.sot,      firstHalf.sot)      : null,
    fouls:    firstHalf ? sub(ft.fouls,    firstHalf.fouls)    : null,
    offsides: firstHalf ? sub(ft.offsides, firstHalf.offsides) : null,
  };

  const payload = {
    fixtureId: fid,
    leagueId: match.league?.id ?? null,
    season: match.league?.season ?? null,
    teams: { home: r.homeId, away: r.awayId },
    fullTime: ft,
    goals1H,
    cards1H,
    secondHalf,
    finalizedAt: new Date().toISOString(),
  };
  await pgQuery(
    `INSERT INTO raw_api_payloads (endpoint, ref_type, ref_id, season, sub_key, payload, fetched_at)
     VALUES ('fixtures/halfstats','fixture',$1,$2,'',$3::jsonb,NOW())
     ON CONFLICT (endpoint, ref_id, sub_key)
     DO UPDATE SET payload = raw_api_payloads.payload || EXCLUDED.payload,
                   season = EXCLUDED.season, fetched_at = NOW()`,
    [fid, payload.season, JSON.stringify(payload)]);
}

// Aritmética de calendario pura sobre 'YYYY-MM-DD' (la fecha ya representa un
// día de Bogotá; no se le aplica zona horaria).
function addDaysStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().split('T')[0];
}

// Fechas objetivo a finalizar. Sin payload.date: la jornada Bogotá que acaba de
// terminar (bogotaToday() a la hora del cron de madrugada España ES esa jornada,
// porque en Bogotá todavía es de noche) + la anterior como red de seguridad
// (recupera lo que la corrida previa no finalizó). El dedup contra match_results
// hace que reprocesar una fecha ya cerrada sea gratis (0 llamadas API).
function resolveDates(payload = {}) {
  if (payload.date) return [String(payload.date)];
  const base = bogotaToday();
  const dates = [base, addDaysStr(base, -1)];
  if (payload.includeNext) dates.unshift(addDaysStr(base, 1));
  return [...new Set(dates)];
}

export async function runFinalize(payload = {}) {
  const apiKey = process.env.FOOTBALL_API_KEY;
  if (!apiKey) throw new Error('FOOTBALL_API_KEY not configured');

  const dates = resolveDates(payload);

  let candidates = 0, finalized = 0, notFinal = 0, noMatch = 0, apiCalls = 0;
  const errors = [];
  const finalizedFids = [];

  for (const date of dates) {
    // Fuente de la lista: match_schedule (durable en Supabase; la escribe
    // futbol-fixtures a las 02:05). NO Redis liveStats (efímero, TTL 2h).
    const schedule = await getMatchSchedule(date).catch((e) => {
      console.error(`[futbol-finalize] getMatchSchedule ${date}:`, e.message);
      return null;
    });
    const kickoffs = Array.isArray(schedule?.kickoffTimes) ? schedule.kickoffTimes : [];
    const fids = [...new Set(
      kickoffs
        .map((k) => Number(k?.fixtureId ?? k?.fixture_id ?? k?.id))
        .filter(Number.isFinite),
    )];
    candidates += fids.length;
    if (fids.length === 0) continue;

    // Dedup: no re-finalizar ni gastar API en lo ya guardado en match_results.
    const { data: existing } = await supabaseAdmin
      .from('match_results').select('fixture_id').in('fixture_id', fids);
    const existingIds = new Set((existing || []).map((row) => row.fixture_id));
    const toCheck = fids.filter((fid) => !existingIds.has(fid));
    if (toCheck.length === 0) continue;

    const res = await mapPool(toCheck, FINALIZE_CONCURRENCY, async (fid) => {
      // UNA llamada general /fixtures?id=X (con rescate de stats para ligas
      // exóticas). Devuelve el resultado completo; nada se pide por mercado.
      const match = await fetchFixture(fid, apiKey);
      apiCalls++;
      if (!match) return { status: 'no-match' };
      if (!FINISHED_STATUSES.includes(match.fixture?.status?.short)) return { status: 'not-final' };

      const r = extractResult(match);
      // full_data = payload entero → ningún campo/mercado se omite a mano.
      const { error } = await upsertMatchResult(fid, date, match, r);
      if (error) throw new Error(`upsert: ${error.message || error}`);
      // referee_stats (se conserva) — fallo aquí NO debe romper el finalize.
      try { await upsertRefereeStats(match, r, date); } catch (e) {
        console.warn(`[futbol-finalize] upsertRefereeStats ${fid}:`, e.message);
      }
      // halfstats fullTime/2ª parte → raw_api_payloads (complementa la captura,
      // que NO trae halfstats).
      try { await persistHalfStatsFull(fid, match, r); } catch (e) {
        console.warn(`[futbol-finalize] persistHalfStatsFull ${fid}:`, e.message);
      }
      return { status: 'finalized' };
    });

    res.forEach((rr, idx) => {
      const fid = toCheck[idx];
      if (!rr.ok) {
        errors.push({ date, fixtureId: fid, error: rr.error.message });
        console.error(`[futbol-finalize] fixture ${fid}:`, rr.error.message);
      } else if (rr.value.status === 'finalized') {
        finalized++;
        finalizedFids.push(fid);
      } else if (rr.value.status === 'not-final') {
        notFinal++;
      } else {
        noMatch++;
      }
    });
  }

  // Nutrir raw_api_payloads con el crudo de los recién finalizados (fixture
  // detalle + statistics/events/lineups/injuries). captureH2H=false: el H2H lo
  // hace el cron de retrain (06:30); aquí evitamos las llamadas extra.
  // Idempotente y de fallo suave: si truena, los resultados ya quedaron en
  // match_results (lo importante para que el modelo no se desnutra).
  let rawCaptured = 0;
  if (finalizedFids.length > 0) {
    try {
      const cap = await captureFinalizedFixturesRaw({ fixtureIds: finalizedFids, captureH2H: false });
      rawCaptured = cap?.fixturesDone ?? 0;
    } catch (e) {
      console.error('[futbol-finalize] captureFinalizedFixturesRaw falló (no crítico):', e.message);
      errors.push({ stage: 'raw-capture', error: e.message });
    }
  }

  console.log(
    `[futbol-finalize] fecha=${dates.join('|')} candidatos=${candidates} ` +
    `finalizados=${finalized} noFinal=${notFinal} sinPartido=${noMatch} ` +
    `errores=${errors.length} apiCalls=${apiCalls} rawCaptured=${rawCaptured}`,
  );

  return {
    ok: true,
    dates,
    candidates,
    finalized,
    notFinal,
    noMatch,
    apiCalls,
    rawCaptured,
    errors: errors.length,
  };
}
