import * as Crypto from 'expo-crypto';

// El motor y los rankings usan el valor crudo; estas funciones son solo visuales.
export function cap(value: unknown): number {
  const normalized = Math.max(0, Math.min(100, Number(value) || 0));
  if (normalized >= 95) return 95;
  return Math.floor((normalized + 1e-9) * 100) / 100;
}

export function rawProbability(entry: any): number {
  return Number(entry?.rawProbability ?? entry?.probability) || 0;
}

export function oddValue(value: unknown): number | null {
  const odd = Number(typeof value === 'object' && value ? (value as any).odd : value);
  return Number.isFinite(odd) && odd > 1 ? odd : null;
}

export function fmtOdd(value: unknown, fallback = '—'): string {
  const odd = oddValue(value);
  return odd ? odd.toFixed(2) : fallback;
}

export function pctText(value: unknown, fallback = '—'): string {
  if (value == null || !Number.isFinite(Number(value))) return fallback;
  return `${cap(value)}%`;
}

export const FOOTBALL_LIVE = new Set(['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE']);
export const FOOTBALL_FINISHED = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO']);
export const FOOTBALL_POSTPONED = new Set(['PST', 'CANC', 'SUSP', 'ABD']);

export const isLive = (status?: string | null) => !!status && FOOTBALL_LIVE.has(status);
export const isFinished = (status?: string | null) => !!status && FOOTBALL_FINISHED.has(status);
export const isPostponed = (status?: string | null) => !!status && FOOTBALL_POSTPONED.has(status);
export const isPendingStatus = (status?: string | null) => status === 'NS' || status === 'TBD';
export const isCoveredCounter = (counter: any) => counter?.isReal === true || Number(counter?.total || 0) > 0;

export function isAwaitingOfficialResult(match: any, now = Date.now()) {
  if (!isPendingStatus(match?.fixture?.status?.short)) return false;
  const kickoff = new Date(match?.fixture?.date || 0).getTime();
  return Number.isFinite(kickoff) && kickoff > 0 && now > kickoff + 130 * 60 * 1000;
}

export const FOOTBALL_STATUS_LABEL: Record<string, string> = {
  NS: 'PRÓXIMO', TBD: 'POR CONFIRMAR', '1H': 'EN VIVO — 1T', '2H': 'EN VIVO — 2T', HT: 'ENTRETIEMPO',
  FT: 'FINALIZADO', ET: 'EN VIVO — Extra', P: 'EN VIVO — Penales', AET: 'FINALIZADO', PEN: 'FINALIZADO',
  SUSP: 'SUSPENDIDO', PST: 'POSPUESTO', CANC: 'CANCELADO', BT: 'DESCANSO',
};

// Béisbol y deportes del motor multideporte.
export const isMultisportLive = (status?: string | null) =>
  !!status && (/^IN\d*$/.test(status) || ['LIVE', 'HT', 'Q1', 'Q2', 'Q3', 'Q4', 'OT'].includes(status));
export const isMultisportFinal = (status?: string | null) => !!status && ['FT', 'AOT', 'FINAL'].includes(status);
export const isMultisportPostponed = (status?: string | null) => !!status && ['POST', 'CANC', 'INTR', 'ABD', 'PST'].includes(status);

export function eventPersonName(value: any): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value.name === 'string' && value.name.trim()) return value.name.trim();
  return 'Autor no informado';
}

export function matchName(game: any, sport: string): string {
  if (sport === 'football') return `${game?.teams?.home?.name || '?'} vs ${game?.teams?.away?.name || '?'}`;
  return `${game?.teams?.home?.name || game?.home_team || '?'} vs ${game?.teams?.away?.name || game?.away_team || '?'}`;
}

export function initials(name: string | null | undefined, count = 2) {
  return String(name || '?').trim().slice(0, count).toUpperCase();
}

export function randomUUID(): string {
  try {
    return Crypto.randomUUID();
  } catch {
    return `${Date.now().toString(16).padStart(12, '0')}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
  }
}
