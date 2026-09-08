/** Entrenamiento walk-forward del motor MLB, sin isotónica ni meta-modelos. */
import { pgPool, refreshPredictionLedgerCalibration, trainMultisportEmpiricalEngine } from '../../shared.js';

export async function runBaseballRetrain(payload = {}) {
  const training = await trainMultisportEmpiricalEngine({
    sport: 'baseball', pool: pgPool,
    limit: Number(payload.limit) > 0 ? Number(payload.limit) : 500,
    dry: payload.dry === true,
  });
  if (payload.dry === true) return training;
  const ledgerCalibration = await refreshPredictionLedgerCalibration('baseball');
  return { ...training, ledgerCalibration };
}
