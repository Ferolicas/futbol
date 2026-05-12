/**
 * mapPool — bounded-concurrency parallel map.
 *
 * Unlike `Promise.all(items.map(mapper))` (unbounded) or batched
 * `Promise.all` (waits for the slowest in each batch), this keeps exactly
 * `concurrency` workers running and each picks up the next item as soon
 * as it finishes. That fully saturates the downstream bottleneck — in our
 * case the shared API-Football rate limiter — without ever idling on a
 * single slow match.
 *
 * Returns an array the same length as `items` with per-item outcome:
 *   { ok: true,  value }  on success
 *   { ok: false, error }  on rejection (errors do NOT abort other workers)
 */
export type PoolResult<T> = { ok: true; value: T } | { ok: false; error: Error };

export async function mapPool<I, T>(
  items: I[],
  concurrency: number,
  mapper: (item: I, index: number) => Promise<T>,
): Promise<PoolResult<T>[]> {
  const results: PoolResult<T>[] = new Array(items.length);
  if (items.length === 0) return results;

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  let nextIdx = 0;

  const worker = async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) return;
      try {
        const value = await mapper(items[idx]!, idx);
        results[idx] = { ok: true, value };
      } catch (e) {
        results[idx] = { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/**
 * Convenience: returns only the successful values. Failures are silently
 * counted (returned via the `errors` array of the same length as items, with
 * undefined for successful slots).
 */
export async function mapPoolValues<I, T>(
  items: I[],
  concurrency: number,
  mapper: (item: I, index: number) => Promise<T>,
): Promise<{ values: (T | undefined)[]; errors: (Error | undefined)[]; failed: number }> {
  const results = await mapPool(items, concurrency, mapper);
  const values: (T | undefined)[] = new Array(items.length);
  const errors: (Error | undefined)[] = new Array(items.length);
  let failed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.ok) values[i] = r.value;
    else {
      errors[i] = r.error;
      failed++;
    }
  }
  return { values, errors, failed };
}
