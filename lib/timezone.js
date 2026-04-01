/**
 * Timezone utilities — all date/time calculations use the user's LOCAL timezone.
 *
 * KEY RULE: A fixture belongs to the date when it kicks off IN THE USER'S TIMEZONE.
 * If it starts at 02:00 UTC and the user is in America/Bogota (UTC-5),
 * that's 21:00 local = same local day. NOT the next day.
 *
 * Never use new Date().toISOString() for "today" — that returns UTC which breaks
 * users in UTC-N timezones after their local midnight.
 */

// Returns today's date as YYYY-MM-DD in the given IANA timezone
export function todayInTz(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  } catch {
    return new Date().toISOString().split('T')[0];
  }
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
  try {
    return new Date(isoDate).toLocaleTimeString('es', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoDate?.substring(11, 16) || '';
  }
}

// Formats a YYYY-MM-DD string for display (weekday, day, month) in the given timezone
export function fmtDateDisplay(dateStr, tz) {
  try {
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('es', {
      timeZone: tz,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  } catch {
    return dateStr;
  }
}

/**
 * Convert a UTC ISO datetime to local date string YYYY-MM-DD in user's timezone.
 * This is THE key function for timezone-aware fixture display.
 *
 * Example:
 *   utcIso = '2025-04-02T01:30:00+00:00' (01:30 UTC)
 *   tz = 'America/Bogota' (UTC-5) → local 20:30 Apr 1 → '2025-04-01'
 *   tz = 'Europe/Madrid' (UTC+2) → local 03:30 Apr 2 → '2025-04-02'
 */
export function getLocalDateForFixture(utcIso, tz = 'UTC') {
  try {
    const date = new Date(utcIso);
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return utcIso?.split('T')[0] || '';
  }
}

/**
 * Filter fixtures to only those that belong to the given local date in the user's timezone.
 * A fixture with date '2025-04-02T01:00:00Z' belongs to Apr 1 for a UTC-5 user.
 */
export function filterFixturesByLocalDate(fixtures, localDate, userTimezone) {
  return fixtures.filter(f => {
    const utcIso = f.fixture?.date;
    if (!utcIso) return false;
    return getLocalDateForFixture(utcIso, userTimezone) === localDate;
  });
}

/**
 * Get UTC date range that encompasses a local date across all possible timezones.
 * UTC-12 to UTC+14 means a local date can span up to 3 UTC calendar days.
 * Use this to know which UTC dates to fetch from the API.
 */
export function getUtcDateRangeForLocalDate(localDate) {
  const d = new Date(localDate + 'T00:00:00Z');
  const prevDay = new Date(d.getTime() - 14 * 60 * 60 * 1000).toISOString().split('T')[0];
  const nextDay = new Date(d.getTime() + 26 * 60 * 60 * 1000).toISOString().split('T')[0];
  return { start: prevDay, end: nextDay };
}

/**
 * Check if a date string (YYYY-MM-DD) is "today" in the user's timezone.
 */
export function isToday(dateStr, tz = 'UTC') {
  return todayInTz(tz) === dateStr;
}

/**
 * Check if a date string (YYYY-MM-DD) is in the past in the user's timezone.
 */
export function isPast(dateStr, tz = 'UTC') {
  return dateStr < todayInTz(tz);
}
