/**
 * Fetcher standard para SWR.
 *
 * Convencion:
 *   - 2xx → JSON parseado.
 *   - 4xx/5xx → throw con un Error enriquecido (status, info) para que SWR
 *     lo trate como error y permita inspeccionarlo desde error.status.
 *   - Network failure → throw propaga el TypeError de fetch.
 */
export async function fetcher(url, init) {
  const res = await fetch(url, { credentials: 'same-origin', ...(init || {}) });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    try { err.info = await res.json(); } catch { err.info = await res.text().catch(() => null); }
    throw err;
  }
  return res.json();
}

/**
 * Wrappers tipados — uno por tipo de dato. Pasados directamente como
 * `fetcher` en useSWR(key, fetcher).
 */
export const fetcherWithCredentials = (url) => fetcher(url, { credentials: 'include' });

/** Para mutaciones POST/PUT/DELETE con SWR.mutate optimistic. */
export async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    try { err.info = await res.json(); } catch {}
    throw err;
  }
  return res.json();
}
