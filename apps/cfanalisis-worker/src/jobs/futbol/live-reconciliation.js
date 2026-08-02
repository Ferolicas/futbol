// Reglas puras de reconciliacion de estados de API-Football.
//
// El proveedor puede devolver temporalmente NS/TBD en el endpoint de detalle
// mientras el feed global ya confirmo que el partido esta en juego. Una vez
// observado un estado live o final, volver a "no iniciado" es una regresion de
// cobertura, no una transicion deportiva valida. Estas funciones mantienen la
// misma regla en el escaneo Redis, la reconciliacion y las pruebas.

export const LIVE_STATUS_SET = new Set(['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE']);
export const FINISHED_STATUS_SET = new Set(['FT', 'AET', 'PEN']);
export const PENDING_STATUS_SET = new Set(['NS', 'TBD']);

export function shouldRejectStatusRegression(currentStatus, incomingStatus) {
  if (!currentStatus || !incomingStatus || currentStatus === incomingStatus) return false;
  if (FINISHED_STATUS_SET.has(currentStatus) && !FINISHED_STATUS_SET.has(incomingStatus)) return true;
  if (LIVE_STATUS_SET.has(currentStatus) && PENDING_STATUS_SET.has(incomingStatus)) return true;
  return false;
}

export function collectStaleLiveFixtureIds(existingLive, cachedFixtures, currentLiveIds) {
  const current = currentLiveIds instanceof Set ? currentLiveIds : new Set(currentLiveIds || []);
  const ids = new Set();

  for (const [fixtureId, snapshot] of Object.entries(existingLive || {})) {
    const id = Number(fixtureId);
    if (Number.isFinite(id) && LIVE_STATUS_SET.has(snapshot?.status?.short) && !current.has(id)) ids.add(id);
  }

  // La cache visible tambien es evidencia de que el partido estuvo live. Esto
  // rescata el caso en que un detalle transitorio NS ya contamino liveStats.
  for (const fixture of (Array.isArray(cachedFixtures) ? cachedFixtures : [])) {
    const id = Number(fixture?.fixture?.id);
    if (Number.isFinite(id) && LIVE_STATUS_SET.has(fixture?.fixture?.status?.short) && !current.has(id)) ids.add(id);
  }

  return [...ids];
}

export function cachedReconciliationKind({ status, kickoff, expectedEnd, now = Date.now(), graceMs = 10 * 60_000 }) {
  const kickoffMs = Number(kickoff);
  const expectedEndMs = Number(expectedEnd);
  const overdue = Number.isFinite(expectedEndMs)
    ? now > expectedEndMs + graceMs
    : Number.isFinite(kickoffMs) && kickoffMs > 0 && now > kickoffMs + 130 * 60_000;

  if (FINISHED_STATUS_SET.has(status)) return 'ft';
  if (PENDING_STATUS_SET.has(status) && overdue) return 'stale';
  if (LIVE_STATUS_SET.has(status) && overdue) return 'live';
  return null;
}
