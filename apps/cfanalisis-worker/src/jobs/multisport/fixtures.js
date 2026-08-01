// @ts-nocheck
import { prepareSportDate, cronTargetDate } from '../../shared.js';

export async function runBasketballFixtures(payload = {}) {
  return prepareSportDate('basketball', payload.date || cronTargetDate(), { ttl: 900 });
}

export async function runAmericanFootballFixtures(payload = {}) {
  return prepareSportDate('american_football', payload.date || cronTargetDate(), { ttl: 900 });
}
