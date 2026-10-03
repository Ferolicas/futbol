import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { cookies } from 'next/headers';
import { redisDel, redisGet, redisSet } from './redis';

const MFA_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-cf_mfa' : 'cf_mfa_dev';
const MFA_TTL_SECONDS = 10 * 60;
const MFA_MAX_ATTEMPTS = 5;

function digest(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function codeHash(challenge, code) {
  return createHmac('sha256', challenge).update(String(code)).digest('hex');
}

function mfaKey(challenge) {
  return `auth:mfa:${digest(challenge)}`;
}

async function setMfaCookie(value, maxAge) {
  (await cookies()).set(MFA_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge,
  });
}

export async function createAdminMfaChallenge(userId) {
  const challenge = randomBytes(32).toString('base64url');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = Date.now() + MFA_TTL_SECONDS * 1000;
  await redisSet(mfaKey(challenge), {
    userId,
    codeHash: codeHash(challenge, code),
    attempts: 0,
    expiresAt,
  }, MFA_TTL_SECONDS);
  await setMfaCookie(challenge, MFA_TTL_SECONDS);
  return code;
}

export async function clearAdminMfaChallenge() {
  const store = await cookies();
  const challenge = store.get(MFA_COOKIE)?.value || '';
  if (challenge) await redisDel(mfaKey(challenge)).catch(() => {});
  await setMfaCookie('', 0);
}

export async function verifyAdminMfaChallenge(code) {
  const challenge = (await cookies()).get(MFA_COOKIE)?.value || '';
  if (!challenge || !/^\d{6}$/.test(String(code || ''))) return null;
  const key = mfaKey(challenge);
  const record = await redisGet(key);
  if (!record?.userId || Number(record.expiresAt) <= Date.now()) {
    await clearAdminMfaChallenge();
    return null;
  }

  const supplied = Buffer.from(codeHash(challenge, code), 'hex');
  const expected = Buffer.from(String(record.codeHash || ''), 'hex');
  const valid = supplied.length === expected.length && timingSafeEqual(supplied, expected);
  if (!valid) {
    const attempts = Number(record.attempts || 0) + 1;
    if (attempts >= MFA_MAX_ATTEMPTS) await clearAdminMfaChallenge();
    else {
      const remaining = Math.max(1, Math.ceil((Number(record.expiresAt) - Date.now()) / 1000));
      await redisSet(key, { ...record, attempts }, remaining);
    }
    return null;
  }

  await redisDel(key);
  await setMfaCookie('', 0);
  return { userId: record.userId };
}
