export function getUserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function todayInTz(tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function fmtTimeInTz(iso: string | null | undefined, tz: string): string {
  if (!iso) return '–';
  try {
    return new Intl.DateTimeFormat('es', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return String(iso).substring(11, 16);
  }
}

export function fmtShortDate(iso: string | null | undefined, tz: string): string {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('es', { timeZone: tz, day: 'numeric', month: 'short' }).format(new Date(iso));
  } catch {
    return '';
  }
}

export function fmtLongDate(iso: string | null | undefined, tz: string): string {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('es', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
  } catch {
    return '';
  }
}

export function fmtDateTime(iso: string | null | undefined, tz: string): string {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('es', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return '';
  }
}

export function shiftIsoDay(date: string, amount: number): string {
  const [year, month, day] = String(date).split('-').map(Number);
  const shifted = new Date(year, month - 1, day + amount, 12);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;
}
