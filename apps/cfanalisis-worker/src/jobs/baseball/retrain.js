// @ts-nocheck
/**
 * Job: baseball-retrain (nocturno, 07:30 España = 00:30 Bogotá día sig.)
 *
 * Ciclo de auto-mejora del modelo ML baseball — corre DESPUÉS de
 * baseball-finalize (05:00) y baseball-calibrate (06:00). Dos pasos:
 *
 *   1) reenrichBaseball()
 *      Lee raw_api_payloads (mlb-schedule + mlb-boxscore + mlb-pitcher-season)
 *      y recalcula features_baseball para los juegos finalizados. UPSERT idempotente.
 *
 *   2) trainBaseballMetaModels()
 *      Re-entrena los 3 modelos logísticos (home_win, run_line_home_minus_15,
 *      total_over_85) con los datos frescos. Cada modelo se inserta INACTIVO
 *      y solo se activa si bate baseline en val (delta_logloss > 0).
 *
 * Ambos pasos son idempotentes y reanudables; si reentrenar falla, queda el
 * modelo activo previo. El siguiente baseball-analyze (al día siguiente)
 * leerá los modelos recién activados.
 *
 * pgPool se pasa explícito a las dos funciones para que compartan el mismo
 * Pool (evita abrir/cerrar pools en cada paso).
 */
import { reenrichBaseball, trainBaseballMetaModels, pgPool } from '../../shared.js';
import { logger } from '../../logger.js';

export async function runBaseballRetrain(_payload = {}) {
  const tStart = Date.now();
  const summary = { ok: true, steps: {} };

  // Paso 1 — reenrich features
  try {
    console.log('[baseball-retrain] (1/2) reenrich-baseball…');
    const t0 = Date.now();
    const res = await reenrichBaseball({ pool: pgPool });
    summary.steps.reenrich = {
      ok: true,
      processed: res?.processed || 0,
      inserted: res?.inserted || 0,
      updated:  res?.updated || 0,
      totalInTable: res?.totalInTable || 0,
      durationSec: Math.round((Date.now() - t0) / 1000),
    };
    console.log(`[baseball-retrain] (1/2) reenrich OK en ${summary.steps.reenrich.durationSec}s — total tabla=${summary.steps.reenrich.totalInTable}`);
  } catch (e) {
    summary.ok = false;
    summary.steps.reenrich = { ok: false, error: e?.message || String(e) };
    logger.error({ step: 'reenrich', err: e?.message }, '[baseball-retrain] reenrich falló');
    // No abortamos el job todavía — train puede correr con datos previos.
  }

  // Paso 2 — train 3 modelos
  try {
    console.log('[baseball-retrain] (2/2) train-baseball-meta-models…');
    const t0 = Date.now();
    const res = await trainBaseballMetaModels({ pool: pgPool });
    summary.steps.train = {
      ok: true,
      results: res?.results || null,
      aborted: !!res?.aborted,
      durationSec: Math.round((Date.now() - t0) / 1000),
    };
    console.log(`[baseball-retrain] (2/2) train OK en ${summary.steps.train.durationSec}s`);
  } catch (e) {
    summary.ok = false;
    summary.steps.train = { ok: false, error: e?.message || String(e) };
    logger.error({ step: 'train', err: e?.message }, '[baseball-retrain] train falló');
  }

  const totalSec = Math.round((Date.now() - tStart) / 1000);
  summary.durationSec = totalSec;
  if (summary.ok) {
    logger.info({ summary: 'baseball-retrain', ...summary }, `baseball-retrain OK en ${totalSec}s`);
  } else {
    logger.error({ summary: 'baseball-retrain', ...summary }, `baseball-retrain con errores en ${totalSec}s`);
    throw new Error(`baseball-retrain incompleto: ${JSON.stringify(summary.steps)}`);
  }
  return summary;
}
