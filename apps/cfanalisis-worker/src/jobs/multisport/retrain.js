// @ts-nocheck
import { pgPool, trainMultisportEmpiricalEngine } from '../../shared.js';

const run = (sport, payload) => trainMultisportEmpiricalEngine({
  sport, pool: pgPool, limit: Number(payload.limit) > 0 ? Number(payload.limit) : 500, dry: payload.dry === true,
});

export const runBasketballRetrain = (payload = {}) => run('basketball', payload);
export const runAmericanFootballRetrain = (payload = {}) => run('american_football', payload);
