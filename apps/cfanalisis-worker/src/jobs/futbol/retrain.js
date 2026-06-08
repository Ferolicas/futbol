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
  pgPool,
  captureFinalizedFixturesRaw,
  computeMarketBaseRates,
  redisSet,
} from '../../shared.js';

export async function runFutbolRetrain(payload = {}) {
  if (process.env.FUTBOL_RETRAIN_ENABLED === 'false') {
    console.log('[futbol-retrain] deshabilitado (FUTBOL_RETRAIN_ENABLED=false)');
    return { ok: true, skipped: 'disabled' };
  }

  const hours = Number(payload?.hours) || 30;
  const captureH2H = payload?.captureH2H !== false;

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

  // 3) (Etapa 4) El re-entreno del ML de ruptura (trainMetaModels) se ELIMINÓ: el
  //    motor viejo (context-engine + su capa ML) fue reemplazado por el motor del
  //    schema `model`, que NO usa modelos de ruptura/familia. La captura (paso 2) se
  //    CONSERVA: alimenta raw_api_payloads → el sync nocturno del modelo (07:00).

  // 4) Tasas base por mercado (prior del shrink de calibración) — DESDE EL CRUDO,
  //    ya con los partidos recién finalizados. Auto-ajusta la base con cada
  //    jornada. Idempotente y FALLA SUAVE: si truena, el motor sigue con las
  //    bases previas (no rompe el retrain ni el análisis).
  try {
    result.baseRates = await computeMarketBaseRates({ pool: pgPool });
  } catch (e) {
    console.error('[futbol-retrain] base-rates falló (no crítico):', e?.message || e);
    result.baseRates = { ok: false, error: String(e?.message || e) };
  }

  console.log(
    `[futbol-retrain] OK · capturados=${result.capture?.fixturesDone ?? 0} · ` +
      `tasas_base=${result.baseRates?.markets ?? 0}`
  );
  // JS-1: dejar rastro para el watchdog (dead-man's switch). TTL 48h.
  await redisSet('lastRun:futbol-retrain', { completedAt: new Date().toISOString() }, 172800);
  return result;
}
