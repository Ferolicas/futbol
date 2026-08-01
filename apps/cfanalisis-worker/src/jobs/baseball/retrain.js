// @ts-nocheck
/** Entrenamiento walk-forward del motor MLB, sin isotónica ni meta-modelos. */
import { pgPool, trainMultisportEmpiricalEngine } from '../../shared.js';

export async function runBaseballRetrain(payload = {}) {
  return trainMultisportEmpiricalEngine({
    sport: 'baseball', pool: pgPool,
    limit: Number(payload.limit) > 0 ? Number(payload.limit) : 500,
    dry: payload.dry === true,
  });
}
