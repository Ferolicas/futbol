// @ts-nocheck
/**
 * Job: futbol-raw-backfill — tanda 2 de la captura cruda total (Camino B).
 * Dispara a las 4:00 AM España (scheduler). Corre la mitad 2 de los equipos.
 * Idempotente: no repite lo que la tanda 1 (manual) ya capturó.
 *
 * Payload: { half?: 1|2, withOdds?: boolean }
 */
import { runRawBackfill } from '../../shared.js';

export async function runRawBackfillJob(data = {}) {
  const half = data?.half || 2;
  const withOdds = !!data?.withOdds;
  console.log(`[job:futbol-raw-backfill] arrancando half=${half}`);
  return runRawBackfill({ half, run: true, withOdds });
}
