// @ts-nocheck
/**
 * Job: futbol-model-sync (FASE 2E) — mantiene el schema `model` fresco cada noche.
 *
 * Corre a las 07:00 Madrid (tras finalize 03/04 y retrain 06:30). Pasos
 * idempotentes y fail-loud: un fallo parcial impide escribir el sello de éxito,
 * BullMQ reintenta y el watchdog alerta si ambos intentos fallan.
 *   1. Recientes finalizados (match_results ≤36h) → asegurar crudo+players
 *      (captureFinalizedFixturesRaw, ahora con fixtures/players) → ingestFixtures(model).
 *   2. Upcoming (hoy/mañana Bogotá, de la caché de fixtures) → filas model.matches
 *      (sin stats; aún no jugados) vía ingestFixtureObjects.
 *   3. Standings OFICIAL de la API para las ligas activas → standings_snapshots
 *      (source='official') + model.matches.home/away_rank_official en los upcoming.
 *
 * Gated por MODEL_SYNC_ENABLED (default ON; ='false' lo apaga). Deja rastro
 * 'lastRun:futbol-model-sync' para el watchdog.
 *
 * Payload: { hours?: number }
 */
import {
  pgQuery, pgPool, captureFinalizedFixturesRaw, ingestFixtures, ingestFixtureObjects,
  buildModelTeamProfiles, buildModelPlayerProfiles,
  getCachedFixturesRaw, redisSet, cronTargetDate, bogotaToday,
  footballApiRequest, retryDueCaptureFailures,
} from '../../shared.js';

async function apiGet(path, key) {
  const result = await footballApiRequest(path, { apiKey: key, timeoutMs: 15_000, retries: 2 });
  return result.response;
}

export async function runModelSync(payload = {}) {
  if (process.env.MODEL_SYNC_ENABLED === 'false') { console.log('[model-sync] deshabilitado (MODEL_SYNC_ENABLED=false)'); return { ok: true, skipped: 'disabled' }; }
  const apiKey = process.env.FOOTBALL_API_KEY;
  if (!apiKey) throw new Error('FOOTBALL_API_KEY no configurada para model-sync');
  const hours = Number(payload?.hours) || 36;
  const result = { ok: true };

  // 1) Recientes finalizados (misma fuente que retrain).
  const { rows } = await pgQuery(`SELECT fixture_id FROM match_results WHERE created_at > NOW() - ($1 || ' hours')::interval`, [String(hours)]);
  const recentFids = rows.map(r => Number(r.fixture_id));
  result.recent = recentFids.length;

  if (recentFids.length) {
    // 1a) asegurar crudo + players (idempotente; casi 0 si retrain ya capturó).
    result.capture = await captureFinalizedFixturesRaw({ fixtureIds: recentFids, captureH2H: false });
    if (Number(result.capture?.failed || 0) > 0) throw new Error(`model-sync captura incompleta: ${result.capture.failed} endpoints`);
    // 1b) ingerir facts recientes → model.
    result.ingestRecent = await ingestFixtures(pgPool, recentFids);
    if (Number(result.ingestRecent?.failed || 0) > 0 || Number(result.ingestRecent?.missingFixtureRaw || 0) > 0) {
      throw new Error(
        `model-sync ingesta incompleta: failed=${result.ingestRecent?.failed || 0} ` +
        `missingFixtureRaw=${result.ingestRecent?.missingFixtureRaw || 0}`
      );
    }
  }

  // 2) Upcoming (hoy/mañana Bogotá) → filas model.matches (sin stats).
  let upObjs = [];
  const dates = [...new Set([cronTargetDate(), bogotaToday()])];
  for (const d of dates) { const fx = await getCachedFixturesRaw(d); if (Array.isArray(fx)) upObjs.push(...fx); }
  // dedup por fixture id
  const seen = new Set(); upObjs = upObjs.filter(f => { const id = f?.fixture?.id; if (!id || seen.has(id)) return false; seen.add(id); return true; });
  if (upObjs.length) result.ingestUpcoming = await ingestFixtureObjects(pgPool, upObjs);
  if (Number(result.ingestUpcoming?.failed || 0) > 0) throw new Error(`model-sync upcoming incompleto: ${result.ingestUpcoming.failed}`);

  // 3) Standings oficial + rank_official de los upcoming.
  result.standings = await syncOfficialStandings(apiKey, recentFids, upObjs);

  // 4) Refresh INCREMENTAL de perfiles descriptivos: solo equipos/jugadores que jugaron.
  const teamIds = new Set();
  for (const f of upObjs) { if (f.teams?.home?.id) teamIds.add(Number(f.teams.home.id)); if (f.teams?.away?.id) teamIds.add(Number(f.teams.away.id)); }
  if (recentFids.length) {
    const { rows: tr } = await pgQuery(`SELECT DISTINCT home_team_id, away_team_id FROM model.matches WHERE fixture_id = ANY($1::bigint[])`, [recentFids]);
    for (const r of tr) { if (r.home_team_id) teamIds.add(Number(r.home_team_id)); if (r.away_team_id) teamIds.add(Number(r.away_team_id)); }
  }
  let playerIds = [];
  if (recentFids.length) {
    const { rows: pr } = await pgQuery(`SELECT DISTINCT player_id FROM model.player_match_stats WHERE fixture_id = ANY($1::bigint[])`, [recentFids]);
    playerIds = pr.map(r => Number(r.player_id));
  }
  const tp = teamIds.size ? await buildModelTeamProfiles(pgPool, { teamIds: [...teamIds] }) : { written: 0 };
  const pp = playerIds.length ? await buildModelPlayerProfiles(pgPool, { playerIds }) : { written: 0 };
  result.profiles = { teams: tp.written, players: pp.written, teamIds: teamIds.size, playerIds: playerIds.length };

  // 5) Refresh teams/statistics al crudo (FASE 2F) de los equipos afectados.
  result.teamStats = await refreshTeamsStatistics(apiKey, recentFids);

  // 6) Cola durable: reintenta vacíos/errores antiguos sin perderlos cuando el
  // fixture sale de la ventana de 36h. El limitador global evita ráfagas.
  result.captureRetries = await retryDueCaptureFailures({ pool: pgPool, limit: Number(payload?.retryLimit) || 300, concurrency: 3 });
  if (Number(result.captureRetries?.failed || 0) > 0 || Number(result.captureRetries?.unroutable || 0) > 0) {
    throw new Error(
      `model-sync ledger incompleto: failed=${result.captureRetries?.failed || 0} ` +
      `unroutable=${result.captureRetries?.unroutable || 0}`
    );
  }
  if (result.captureRetries?.fixtureIds?.length) {
    result.retryIngest = await ingestFixtures(pgPool, result.captureRetries.fixtureIds);
    if (Number(result.retryIngest?.failed || 0) > 0 || Number(result.retryIngest?.missingFixtureRaw || 0) > 0) {
      throw new Error(
        `model-sync reingesta de reintentos incompleta: failed=${result.retryIngest?.failed || 0} ` +
        `missingFixtureRaw=${result.retryIngest?.missingFixtureRaw || 0}`
      );
    }
  }

  await redisSet('lastRun:futbol-model-sync', { completedAt: new Date().toISOString() }, 172800);
  console.log(`[model-sync] OK · recientes=${result.recent} · ingRecent=${result.ingestRecent?.done ?? 0} · ingUpcoming=${result.ingestUpcoming?.done ?? 0} · standings(ligas=${result.standings?.leagues ?? 0}) · perfiles(eq=${result.profiles?.teams ?? 0}, jug=${result.profiles?.players ?? 0}) · teamStats=${result.teamStats?.saved ?? 0} · retries=${result.captureRetries?.resolved ?? 0}/${result.captureRetries?.due ?? 0}`);
  return result;
}

async function syncOfficialStandings(apiKey, recentFids, upObjs) {
  if (!apiKey) return { skipped: 'no-key' };
  const pairs = new Set();
  for (const f of upObjs) { const lid = f.league?.id, s = f.league?.season; if (lid && s) pairs.add(`${lid}:${s}`); }
  if (recentFids.length) {
    const { rows } = await pgQuery(`SELECT DISTINCT competition_id, season FROM model.matches WHERE fixture_id = ANY($1::bigint[]) AND competition_id IS NOT NULL AND season IS NOT NULL`, [recentFids]);
    for (const r of rows) pairs.add(`${r.competition_id}:${r.season}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  let leagues = 0, teams = 0, rankUpdated = 0;
  for (const pair of pairs) {
    const [lid, season] = pair.split(':').map(Number);
    const data = await apiGet(`/standings?league=${lid}&season=${season}`, apiKey);
    const table = (data?.[0]?.league?.standings || []).flat();
    if (!table.length) continue;
    leagues++;
    for (const e of table) {
      const tid = e.team?.id; if (!tid) continue;
      await pgQuery(
        `INSERT INTO model.standings_snapshots (competition_id,season,team_id,as_of_date,source,played,won,drawn,lost,gf,ga,gd,points,rank,form5,updated_at)
         VALUES ($1,$2,$3,$4::date,'official',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
         ON CONFLICT (competition_id,season,team_id,as_of_date,source) DO UPDATE SET
           played=EXCLUDED.played,won=EXCLUDED.won,drawn=EXCLUDED.drawn,lost=EXCLUDED.lost,gf=EXCLUDED.gf,ga=EXCLUDED.ga,
           gd=EXCLUDED.gd,points=EXCLUDED.points,rank=EXCLUDED.rank,form5=EXCLUDED.form5,updated_at=now()`,
        [lid, season, tid, today, e.all?.played, e.all?.win, e.all?.draw, e.all?.lose, e.all?.goals?.for, e.all?.goals?.against, e.goalsDiff, e.points, e.rank, e.form]);
      teams++;
    }
    const rankByTeam = {}; for (const e of table) if (e.team?.id) rankByTeam[e.team.id] = e.rank;
    for (const f of upObjs.filter(x => x.league?.id === lid)) {
      const fid = Number(f.fixture?.id), h = f.teams?.home?.id, a = f.teams?.away?.id;
      const hr = rankByTeam[h] ?? null, ar = rankByTeam[a] ?? null;
      if (hr == null && ar == null) continue;
      const res = await pgQuery(`UPDATE model.matches SET home_rank_official=$2, away_rank_official=$3 WHERE fixture_id=$1`, [fid, hr, ar]);
      rankUpdated += res.rowCount || 0;
    }
  }
  return { leagues, teams, rankUpdated };
}

// Refresca teams/statistics (agregado propio de la API) al crudo, para los equipos
// de los partidos recientes. Va a raw_api_payloads (uso futuro); los perfiles del
// modelo se construyen de los hechos por-partido, NO de aquí.
async function refreshTeamsStatistics(apiKey, recentFids) {
  if (!apiKey || !recentFids.length) return { skipped: true };
  const { rows } = await pgQuery(`SELECT DISTINCT home_team_id, away_team_id, competition_id, season FROM model.matches WHERE fixture_id = ANY($1::bigint[]) AND competition_id IS NOT NULL AND season IS NOT NULL`, [recentFids]);
  const tuples = new Set();
  for (const r of rows) {
    if (r.home_team_id) tuples.add(`${r.home_team_id}:${r.competition_id}:${r.season}`);
    if (r.away_team_id) tuples.add(`${r.away_team_id}:${r.competition_id}:${r.season}`);
  }
  let saved = 0;
  for (const tp of tuples) {
    const [team, lid, season] = tp.split(':').map(Number);
    const data = await apiGet(`/teams/statistics?team=${team}&league=${lid}&season=${season}`, apiKey);
    const hasData = Array.isArray(data) ? data.length > 0 : !!(data && typeof data === 'object' && Object.keys(data).length > 0);
    if (!hasData) {
      try {
        await pgQuery(
          `INSERT INTO api_capture_failures(endpoint,ref_id,sub_key,attempts,status,last_error,last_attempt_at,next_retry_at)
           VALUES ('teams/statistics',$1,$2,1,'empty','respuesta válida vacía',NOW(),NOW()+INTERVAL '24 hours')
           ON CONFLICT(endpoint,ref_id,sub_key) DO UPDATE SET attempts=api_capture_failures.attempts+1,status='empty',last_error=EXCLUDED.last_error,last_attempt_at=NOW(),next_retry_at=EXCLUDED.next_retry_at,resolved_at=NULL`,
          [team, `s:${season}:l:${lid}`],
        );
      } catch {}
      continue;
    }
    await pgQuery(
      `INSERT INTO raw_api_payloads (endpoint,ref_type,ref_id,season,sub_key,payload,fetched_at)
       VALUES ('teams/statistics','team',$1,$2,$3,$4::jsonb,NOW())
       ON CONFLICT (endpoint,ref_id,sub_key) DO UPDATE SET payload=EXCLUDED.payload, season=EXCLUDED.season, fetched_at=NOW()`,
      [team, season, `s:${season}:l:${lid}`, JSON.stringify({ response: data })]);
    try {
      await pgQuery(
        `UPDATE api_capture_failures SET resolved_at=NOW(),next_retry_at=NULL,last_error=NULL
         WHERE endpoint='teams/statistics' AND ref_id=$1 AND sub_key=$2`,
        [team, `s:${season}:l:${lid}`],
      );
    } catch {}
    saved++;
  }
  return { tuples: tuples.size, saved };
}
