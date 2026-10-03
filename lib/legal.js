import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { pgQuery } from './db';
import { LEGAL_DOCUMENT_VERSION } from './legal-constants';

export { LEGAL_DOCUMENT_VERSION, LEGAL_DOCUMENTS } from './legal-constants';

function privateHash(value) {
  if (!value) return null;
  const secret = process.env.LEGAL_EVIDENCE_SECRET || process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error('LEGAL_EVIDENCE_SECRET or AUTH_JWT_SECRET is required');
  return createHash('sha256').update(`${secret}:${value}`).digest('hex');
}

export function prepareLegalEvidence(request, source = 'web', purpose = 'legal') {
  const acceptedAt = new Date().toISOString();
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || null;
  const userAgent = request.headers.get('user-agent') || null;
  const ipHash = privateHash(ip);
  const userAgentHash = privateHash(userAgent);
  const evidenceHash = privateHash([
    LEGAL_DOCUMENT_VERSION,
    acceptedAt,
    source,
    purpose,
    ipHash || '',
    userAgentHash || '',
  ].join(':'));
  return { acceptedAt, source, ipHash, userAgentHash, evidenceHash };
}

export async function recordMarketingPreference(userId, enabled, evidence, client = null) {
  const run = client ? client.query.bind(client) : pgQuery;
  const result = await run(
    `INSERT INTO public.marketing_consent_events (
       user_id, action, policy_version, source, occurred_at,
       ip_hash, user_agent_hash, evidence_hash
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, action, occurred_at`,
    [
      userId,
      enabled ? 'consent' : 'withdrawal',
      LEGAL_DOCUMENT_VERSION,
      evidence.source,
      evidence.acceptedAt,
      evidence.ipHash,
      evidence.userAgentHash,
      evidence.evidenceHash,
    ],
  );
  return result.rows[0];
}

export async function currentMarketingPreference(userId) {
  const result = await pgQuery(
    `SELECT action, occurred_at
       FROM public.marketing_consent_events
      WHERE user_id = $1
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1`,
    [userId],
  );
  return {
    enabled: result.rows[0]?.action === 'consent',
    updatedAt: result.rows[0]?.occurred_at || null,
  };
}

function marketingTokenSecret() {
  const secret = process.env.LEGAL_EVIDENCE_SECRET || process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error('LEGAL_EVIDENCE_SECRET or AUTH_JWT_SECRET is required');
  return secret;
}

export function createMarketingUnsubscribeToken(userId) {
  const payload = Buffer.from(String(userId), 'utf8').toString('base64url');
  const signature = createHmac('sha256', marketingTokenSecret()).update(`marketing:${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyMarketingUnsubscribeToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', marketingTokenSecret()).update(`marketing:${payload}`).digest();
  let supplied;
  try { supplied = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  const userId = Buffer.from(payload, 'base64url').toString('utf8');
  return /^[0-9a-f-]{36}$/i.test(userId) ? userId : null;
}

export async function recordLegalAcceptance(userId, evidence, client = null) {
  const run = client ? client.query.bind(client) : pgQuery;
  const result = await run(
    `INSERT INTO public.legal_acceptances (
       user_id, document_set_version, terms_version, privacy_version, cookies_version,
       terms_accepted, privacy_acknowledged, data_processing_authorized, age_confirmed,
       acceptance_source, accepted_at, ip_hash, user_agent_hash, evidence_hash
     ) VALUES ($1, $2, $2, $2, $2, true, true, true, true, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, document_set_version) DO NOTHING
     RETURNING id, accepted_at`,
    [
      userId,
      LEGAL_DOCUMENT_VERSION,
      evidence.source,
      evidence.acceptedAt,
      evidence.ipHash,
      evidence.userAgentHash,
      evidence.evidenceHash,
    ],
  );
  return result.rows[0] || null;
}

export async function currentLegalAcceptance(userId) {
  const result = await pgQuery(
    `SELECT accepted_at
       FROM public.legal_acceptances
      WHERE user_id = $1 AND document_set_version = $2
        AND terms_accepted = true
        AND privacy_acknowledged = true
        AND data_processing_authorized = true
        AND age_confirmed = true
      LIMIT 1`,
    [userId, LEGAL_DOCUMENT_VERSION],
  );
  return result.rows[0] || null;
}
