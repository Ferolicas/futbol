// @ts-nocheck
/**
 * Job: futbol-retrain — ciclo nocturno del motor empírico contextual.
 *
 * Corre DESPUÉS de finalize (03:00/04:00), a las 06:30
 * España (= 23:30 Bogotá, baja actividad live para no starvear los polls
 * mientras entrena). Cuatro pasos SECUENCIALES en un solo job (orden
 * garantizado, un solo lock):
 *
 *   1. capture  → crudos por-fixture de los partidos recién finalizados
 *                 (raw_api_payloads). SIN esto, reenrich/profiles/train no ven
 *                 los partidos nuevos (ningún otro cron los persiste).
 *   2. ingest   → raw_api_payloads a hechos model.* sin degradar datos válidos.
 *   3. profiles → refresca perfiles descriptivos.
 *   4. train    → walk-forward del peso de actualidad; solo activa si mejora
 *                 Brier/calibración fuera de muestra.
 *   El XI se aprende directamente como similitud entre alineaciones históricas
 *   point-in-time; no se aplica una tabla agregada de impacto contrafactual.
 *
 * Idempotente. Gated por FUTBOL_RETRAIN_ENABLED (default ON; ='false' lo apaga).
 *
 * Payload: { fixtureIds?: number[], hours?: number, captureH2H?: boolean }
 *   - fixtureIds: fuerza un set concreto (útil para re-correr a mano).
 *   - hours: ventana de finalized_at a recoger (default 30h, cubre el hueco
 *     entre dos ciclos nocturnos contiguos).
 */
import {
  pgQuery,
  pgPool,
  captureFinalizedFixturesRaw,
  ingestFixtures,
  buildModelTeamProfiles,
  buildModelPlayerProfiles,
  trainFootballEmpiricalEngine,
  redisSet,
} from '../../shared.js';

export async function runFutbolRetrain(payload = {}) {
  if (process.env.FUTBOL_RETRAIN_ENABLED === 'false') {
    console.log('[futbol-retrain] deshabilitado (FUTBOL_RETRAIN_ENABLED=false)');
    return { ok: true, skipped: 'disabled' };
  }

  const hours = Number(payload?.hours) || 30;
  // Los H2H ya son hechos en model.team_match_stats (opponent_id); pedir el
  // endpoint /headtohead los duplicaría y gastaría cuota sin aportar evidencia.
  const captureH2H = payload?.captureH2H === true;

  // 1) Fixtures recién finalizados (o set explícito del payload). FUENTE:
  //    match_results — finalize.js la escribe para CADA partido terminado. (Ya
  //    no se usa match_predictions: con el motor de contexto _savePrediction no
  //    la puebla, así que finalized_at no se actualiza ahí.)
  let fixtureIds = Array.isArray(payload?.fixtureIds) ? payload.fixtureIds.map(Number) : null;
  if (!fixtureIds) {
    const { rows } = await pgQuery(
      `SELECT fixture_id FROM match_results
       WHERE created_at > NOW() - ($1 || ' hours')::interval`,
      [String(hours)]
    );
    fixtureIds = rows.map((r) => Number(r.fixture_id));
  }
  console.log(`[futbol-retrain] partidos recién finalizados (≤${hours}h): ${fixtureIds.length}`);

  const result = { ok: true, fixtures: fixtureIds.length };

  // 2) Captura focalizada de crudos (API): trae el crudo de los partidos recién
  //    finalizados (fixtures detalle + statistics/events/lineups/injuries/H2H).
  //    Imprescindible: ningún otro cron persiste raw_api_payloads. Si no hay
  //    fixtures nuevos, igual se re-entrena con el corpus existente.
  result.capture = fixtureIds.length
    ? await captureFinalizedFixturesRaw({ fixtureIds, captureH2H })
    : { skipped: 'no-new-fixtures' };
  if (Number(result.capture?.failed || 0) > 0) {
    throw new Error(`captura nocturna incompleta: ${result.capture.failed} endpoints fallaron`);
  }

  // 3) Ingesta inmediata: el entrenamiento de esta misma corrida ya ve los
  // partidos recién finalizados (antes esperaba al model-sync de las 07:00).
  result.ingest = fixtureIds.length
    ? await ingestFixtures(pgPool, fixtureIds)
    : { skipped: 'no-new-fixtures' };
  if (Number(result.ingest?.failed || 0) > 0 || Number(result.ingest?.missingFixtureRaw || 0) > 0) {
    throw new Error(
      `ingesta nocturna incompleta: failed=${result.ingest?.failed || 0} ` +
      `missingFixtureRaw=${result.ingest?.missingFixtureRaw || 0}`
    );
  }

  // 4) Perfiles descriptivos incrementales de equipos/jugadores afectados.
  const teamIds = new Set();
  let playerIds = [];
  if (fixtureIds.length) {
    const { rows: teams } = await pgQuery(
      `SELECT DISTINCT home_team_id,away_team_id FROM model.matches WHERE fixture_id=ANY($1::bigint[])`,
      [fixtureIds]);
    for (const row of teams) { if (row.home_team_id) teamIds.add(Number(row.home_team_id)); if (row.away_team_id) teamIds.add(Number(row.away_team_id)); }
    const { rows: players } = await pgQuery(
      `SELECT DISTINCT player_id FROM model.player_match_stats WHERE fixture_id=ANY($1::bigint[])`,
      [fixtureIds]);
    playerIds = players.map((row) => Number(row.player_id));
  }
  const teamProfiles = teamIds.size ? await buildModelTeamProfiles(pgPool, { teamIds: [...teamIds], minN: 1 }) : { written: 0 };
  const playerProfiles = playerIds.length ? await buildModelPlayerProfiles(pgPool, { playerIds, minN: 1 }) : { written: 0 };
  result.profiles = { teams: teamProfiles.written, players: playerProfiles.written };

  // 5) Entrenamiento real point-in-time. Un candidato malo queda registrado
  // inactivo y el campeón sigue sirviendo; nunca se degrada producción.
  result.training = await trainFootballEmpiricalEngine({
    pool: pgPool,
    // 1.200 partidos recientes → 840 para elegir pesos + 360 cronológicos
    // intocables para validación. En VPS tarda ~5 min dentro del lock maratón.
    limit: Number(payload?.trainLimit) || 1200,
  });

  console.log(
    `[futbol-retrain] OK · capturados=${result.capture?.fixturesDone ?? 0} · ` +
      `ingest=${result.ingest?.done ?? 0} · trainVersion=${result.training?.version ?? 'sin-cambio'} ` +
      `share=${result.training?.candidateShare ?? '—'} active=${result.training?.activates ?? false}`
  );
  // JS-1: dejar rastro para el watchdog (dead-man's switch). TTL 48h.
  await redisSet('lastRun:futbol-retrain', { completedAt: new Date().toISOString() }, 172800);
  return result;
}
