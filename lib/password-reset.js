import { createHash, randomBytes } from 'crypto';
import { redisDel, redisSet, redisTake } from './redis';
import { sendPasswordResetEmail } from './email';

const RESET_TTL_SECONDS = 60 * 60;

function tokenDigest(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

function resetKey(token) {
  return `pwd-reset:v2:${tokenDigest(token)}`;
}

export async function issuePasswordReset({ userId, email, name }) {
  const token = randomBytes(32).toString('hex');
  const key = resetKey(token);
  await redisSet(key, { userId, email, issuedAt: new Date().toISOString() }, RESET_TTL_SECONDS);
  try {
    await sendPasswordResetEmail({ to: email, name, token });
  } catch (error) {
    await redisDel(key).catch(() => {});
    throw error;
  }
  return token;
}

export async function takePasswordReset(token) {
  if (!/^[0-9a-f]{64}$/i.test(String(token || ''))) return null;
  return redisTake(resetKey(token));
}
