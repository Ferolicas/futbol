/**
 * Module-level cache for instant navigation between the dashboard and
 * the analysis detail page (/dashboard/analisis/[id]).
 *
 * Flow:
 *   1. Dashboard already has every analyzed match in `analyzedData[fid]`.
 *   2. When the user clicks "Ver análisis completo", we hand off the data
 *      here before calling router.push. The detail page reads it on mount.
 *   3. Detail page renders instantly with the cached payload, then revalidates
 *      in background by hitting /api/match/[id].
 *
 * Why module-level (not sessionStorage):
 *   - Faster (no JSON serialization on hot path).
 *   - Survives client-side navigation but not full reloads — exactly the
 *     scope we want.
 */

const _store = new Map();

const TTL_MS = 5 * 60 * 1000; // 5 min — long enough for normal nav patterns

export function setAnalysisCache(fixtureId, payload) {
  if (!fixtureId || !payload) return;
  _store.set(String(fixtureId), { payload, ts: Date.now() });
  // Soft cap: evict oldest if we balloon over 100 entries
  if (_store.size > 100) {
    const oldest = [..._store.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) _store.delete(oldest[0]);
  }
}

export function getAnalysisCache(fixtureId) {
  if (!fixtureId) return null;
  const entry = _store.get(String(fixtureId));
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    _store.delete(String(fixtureId));
    return null;
  }
  return entry.payload;
}

export function clearAnalysisCache() {
  _store.clear();
}
