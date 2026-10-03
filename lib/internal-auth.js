import { timingSafeEqual } from 'crypto';

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Internal automation authentication. Secrets are accepted only in the
 * Authorization header so they never land in URLs, browser history or access
 * logs. Caddy redacts this header by default.
 */
export function isCronAuthorized(request) {
  const expected = process.env.CRON_SECRET;
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+([^\s]{32,512})$/i.exec(header);
  return Boolean(expected && match && safeEqual(match[1], expected));
}
