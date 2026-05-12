// @ts-nocheck
/**
 * Persistent error log for the /ferney dashboard.
 *
 * Errors get pushed into a per-date Upstash Redis list capped at 500 entries.
 * The list is read by the worker's /admin/status endpoint and rendered on
 * the dashboard. We use Upstash (not the local Redis behind BullMQ) so the
 * data is the same source-of-truth as the rest of the app cache.
 */
import { redisGet, redisSet } from './shared.js';

const KEY = (date) => `errors:${date}:list`;
const MAX_ENTRIES = 500;
const TTL_SECONDS = 7 * 24 * 3600; // 7 days

/**
 * Push an error entry for `date` (YYYY-MM-DD). Trims the list so we keep
 * only the most-recent MAX_ENTRIES.
 *
 * @param {string} date
 * @param {{
 *   job: string,                  // 'futbol-analyze-batch' | 'futbol-lineups' | ...
 *   fixtureId?: number|string,
 *   homeTeam?: string,
 *   awayTeam?: string,
 *   league?: string,
 *   kickoff?: string,
 *   error: string,
 * }} entry
 */
export async function logError(date, entry) {
  if (!date || !entry?.error) return;
  try {
    const existing = (await redisGet(KEY(date))) || [];
    const arr = Array.isArray(existing) ? existing : [];
    arr.unshift({
      ts: new Date().toISOString(),
      ...entry,
      error: String(entry.error).slice(0, 500),
    });
    if (arr.length > MAX_ENTRIES) arr.length = MAX_ENTRIES;
    await redisSet(KEY(date), arr, TTL_SECONDS);
  } catch (e) {
    console.error('[errors-log] failed to persist:', e.message);
  }
}

/**
 * Read the error log for `date`. Returns newest-first array (possibly empty).
 */
export async function getErrors(date) {
  if (!date) return [];
  try {
    const data = await redisGet(KEY(date));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
