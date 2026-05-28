// @ts-nocheck
/**
 * Job: futbol-retrain — ciclo nocturno de auto-mejora del meta-modelo CONTEXTUAL.
 *
 * Corre DESPUÉS de finalize (03:00/04:00) y calibrate (05:00), a las 06:30
 * España (= 23:30 Bogotá, baja actividad live para no starvear los polls
 * mientras entrena). Cuatro pasos SECUENCIALES en un solo job (orden
 * garantizado, un solo lock):
 *
 *   1. capture  → crudos por-fixture de los partidos recién finalizados
 *                 (raw_api_payloads). SIN esto, reenrich/profiles/train no ven
 *                 los partidos nuevos (ningún otro cron los persiste).
 *   2. reenrich → features_full point-in-time de esos fixtures, desde los crudos.
 *   3. profiles → reconstruye team_market_profiles (ADN runtime) con datos nuevos.
 *   4. train    → re-entrena los mercados y re-activa los que superan baseline.
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
  captureFinalizedFixturesRaw,
  reenrichFeatures,
  buildTeamProfiles,
  trainMetaModels,
} from '../../shared.js';

export async function runFutbolRetrain(payload = {}) {
  if (process.env.FUTBOL_RETRAIN_ENABLED === 'false') {
    console.log('[futbol-retrain] deshabilitado (FUTBOL_RETRAIN_ENABLED=false)');
    return { ok: true, skipped: 'disabled' };
  }

  const hours = Number(payload?.hours) || 30;
  const captureH2H = payload?.captureH2H !== false;

  // 1) Fixtures recién finalizados (o set explícito del payload).
  let fixtureIds = Array.isArray(payload?.fixtureIds) ? payload.fixtureIds.map(Number) : null;
  if (!fixtureIds) {
    const { rows } = await pgQuery(
      `SELECT fixture_id FROM match_predictions
       WHERE finalized_at IS NOT NULL
         AND finalized_at > NOW() - ($1 || ' hours')::interval
         AND actuals_full IS NOT NULL`,
      [String(hours)]
    );
    fixtureIds = rows.map((r) => Number(r.fixture_id));
  }
  console.log(`[futbol-retrain] partidos recién finalizados (≤${hours}h): ${fixtureIds.length}`);

  const result = { ok: true, fixtures: fixtureIds.length };

  // 2) Captura focalizada de crudos (API). Si no hay fixtures nuevos, igual se
  //    re-entrena con el corpus existente (los crudos ya están).
  result.capture = fixtureIds.length
    ? await captureFinalizedFixturesRaw({ fixtureIds, captureH2H })
    : { skipped: 'no-new-fixtures' };

  // 3) Re-enriquecer features_full SOLO de los fixtures nuevos (incremental).
  result.reenrich = fixtureIds.length
    ? await reenrichFeatures({ fixtureIds })
    : { skipped: 'no-new-fixtures' };

  // 4) Reconstruir el ADN runtime con TODOS los crudos (incluidos los nuevos).
  result.profiles = await buildTeamProfiles({});

  // 5) Re-entrenar todos los mercados; activa los que superan baseline.
  result.train = await trainMetaModels({});

  console.log(
    `[futbol-retrain] OK · capturados=${result.capture?.fixturesDone ?? 0} · ` +
      `reenrich=${result.reenrich?.done ?? 0} · perfiles=${result.profiles?.rows ?? 0} · ` +
      `entrenados=${result.train?.trained ?? 0} · activos=${result.train?.activated ?? 0}`
  );
  return result;
}
