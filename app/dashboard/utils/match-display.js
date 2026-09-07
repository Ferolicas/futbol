import { TIMEZONE_TO_COUNTRY } from '../../../lib/bookmakers';
import { fmtTimeInTz, getUserTz, todayInTz } from '../../../lib/timezone';

export function detectCountry() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TIMEZONE_TO_COUNTRY[tz] || 'default';
  } catch {
    return 'default';
  }
}

export const today = tz => todayInTz(tz || getUserTz());
export const fmtTime = (date, tz) => fmtTimeInTz(date, tz || getUserTz());
export const isLive = status => ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'].includes(status);
export const isFinished = status => ['FT', 'AET', 'PEN', 'AWD', 'WO'].includes(status);
export const isPostponed = status => ['PST', 'CANC', 'SUSP', 'ABD'].includes(status);
export const isCoveredCounter = counter => counter?.isReal === true || Number(counter?.total || 0) > 0;
export const isPendingStatus = status => ['NS', 'TBD'].includes(status);

export function isAwaitingOfficialResult(match, now = Date.now()) {
  if (!isPendingStatus(match?.fixture?.status?.short)) return false;
  const kickoff = new Date(match?.fixture?.date || 0).getTime();
  return Number.isFinite(kickoff) && kickoff > 0 && now > kickoff + 130 * 60 * 1000;
}

export const statusText = status => ({
  NS: 'Proximo', '1H': '1T', '2H': '2T', HT: 'Entretiempo',
  FT: 'Final', ET: 'Extra', P: 'Penales', AET: 'Extra', PEN: 'Penales',
  SUSP: 'Suspendido', PST: 'Pospuesto', CANC: 'Cancelado',
}[status] || status);

// El motor y los rankings usan el valor crudo. Esta función es solo visual.
export function cap(value) {
  const normalized = Math.max(0, Math.min(100, Number(value) || 0));
  if (normalized >= 95) return 95;
  return Math.floor((normalized + 1e-9) * 100) / 100;
}
