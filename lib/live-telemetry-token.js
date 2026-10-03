import { createHmac, timingSafeEqual } from 'crypto';

const MAX_FUTURE_MS = 15 * 60 * 1000;

function secret() {
  const value = process.env.WORKER_SECRET;
  if (!value || value.length < 32) throw new Error('WORKER_SECRET missing or too short');
  return value;
}

function message(fid, minute, expiresAt) {
  return `${Number(fid)}:${String(minute)}:${Number(expiresAt)}`;
}

export function createLiveTelemetryToken(fid, minute, expiresAt = Date.now() + 10 * 60 * 1000) {
  const signature = createHmac('sha256', secret())
    .update(message(fid, minute, expiresAt))
    .digest('base64url');
  return { token: signature, expiresAt };
}

export function verifyLiveTelemetryToken(fid, minute, expiresAt, token) {
  const expiry = Number(expiresAt);
  const now = Date.now();
  if (!Number.isFinite(expiry) || expiry < now || expiry > now + MAX_FUTURE_MS) return false;
  let supplied;
  try { supplied = Buffer.from(String(token || ''), 'base64url'); } catch { return false; }
  const expected = createHmac('sha256', secret())
    .update(message(fid, minute, expiry))
    .digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
