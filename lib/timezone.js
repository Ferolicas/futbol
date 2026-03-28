/**
 * Timezone utilities — all date/time calculations use the user's LOCAL timezone.
 * Never use new Date().toISOString() for "today" — that returns UTC which breaks
 * users in UTC-N timezones after their local midnight.
 */

// Returns today's date as YYYY-MM-DD in the given IANA timezone
export function todayInTz(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

// Returns the user's IANA timezone string (client-only, falls back to UTC on server)
export function getUserTz() {
  if (typeof window === 'undefined') return 'UTC';
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// Formats a UTC ISO date string as HH:MM in the given timezone
export function fmtTimeInTz(isoDate, tz) {
  return new Date(isoDate).toLocaleTimeString('es', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Formats a YYYY-MM-DD string for display (weekday, day, month) in the given timezone
export function fmtDateDisplay(dateStr, tz) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('es', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}
