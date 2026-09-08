import { pgPool, refreshPredictionLedgerCalibration, trainMultisportEmpiricalEngine } from '../../shared.js';

const run = async (sport, payload) => {
  const training = await trainMultisportEmpiricalEngine({
    sport, pool: pgPool, limit: Number(payload.limit) > 0 ? Number(payload.limit) : 500, dry: payload.dry === true,
  });
  if (payload.dry === true) return training;
  const ledgerCalibration = await refreshPredictionLedgerCalibration(sport);
  return { ...training, ledgerCalibration };
};

export const runBasketballRetrain = (payload = {}) => run('basketball', payload);
export const runAmericanFootballRetrain = (payload = {}) => run('american_football', payload);
