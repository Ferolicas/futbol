import { processPendingPredictionSeals } from '../shared.js';

export async function runPredictionSeals(): Promise<unknown> {
  return processPendingPredictionSeals();
}
