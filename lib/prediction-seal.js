import crypto, { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pgPool } from './db.js';
import { buildMerkleTree, canonicalJsonBytes, recommendationSealPayload, sha512Hex, verifyMerkleProof } from './prediction-seal-core.js';

const PROVIDER = 'FreeTSA';
const DEFAULT_URL = 'https://freetsa.org/tsr';
const BATCH_SIZE = 16;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ROOT_CERT_URL = new URL('../config/freetsa-root.pem', import.meta.url);

function derLength(length) {
  if (length < 128) return Buffer.from([length]);
  const bytes = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

export function buildRfc3161Request(rootHash) {
  const digest = Buffer.isBuffer(rootHash) ? rootHash : Buffer.from(rootHash, 'hex');
  if (digest.length !== 64) throw new TypeError('RFC 3161 SHA-512 imprint must contain 64 bytes');
  const sha512Algorithm = der(0x30, Buffer.from('06096086480165030402030500', 'hex'));
  const imprint = der(0x30, Buffer.concat([sha512Algorithm, der(0x04, digest)]));
  return der(0x30, Buffer.concat([Buffer.from([0x02, 0x01, 0x01]), imprint, Buffer.from([0x01, 0x01, 0xff])]));
}

function run(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    const stdout = [];
    const stderr = [];
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const result = { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(result.stderr.toString('utf8').trim() || `${binary} exited with ${code}`), result));
    });
  });
}

async function verifyTsrArtifacts({ request, response, expectedRoot }) {
  const work = await mkdtemp(path.join(tmpdir(), 'cf-tsa-'));
  try {
    const queryPath = path.join(work, 'request.tsq');
    const replyPath = path.join(work, 'response.tsr');
    const rootPath = path.join(work, 'root.pem');
    const tokenPath = path.join(work, 'token.der');
    await Promise.all([
      writeFile(queryPath, request, { mode: 0o600 }),
      writeFile(replyPath, response, { mode: 0o600 }),
      writeFile(rootPath, await readFile(ROOT_CERT_URL), { mode: 0o600 }),
    ]);
    await run('openssl', ['ts', '-verify', '-in', replyPath, '-queryfile', queryPath, '-CAfile', rootPath]);
    const info = await run('openssl', ['ts', '-reply', '-in', replyPath, '-text']);
    const text = info.stdout.toString('utf8');
    if (!/Hash Algorithm:\s*sha512/i.test(text)) throw new Error('FreeTSA response did not use SHA-512');
    const normalizedRoot = String(expectedRoot).toLowerCase();
    const imprintBlock = text.match(/Message data:\s*([\s\S]*?)(?:\n\s*Serial number:|\n\s*Time stamp:)/i)?.[1] || '';
    const responseImprint = imprintBlock.split('\n').map((line) => line
      .replace(/^\s*[0-9a-f]{4}\s*-\s*/i, '')
      .split(/\s{2,}/)[0])
      .flatMap((line) => line.match(/[0-9a-f]{2}/gi) || [])
      .join('').toLowerCase();
    if (responseImprint !== normalizedRoot) throw new Error('FreeTSA response imprint does not match the Merkle root');
    const timeText = text.match(/Time stamp:\s*(.+)/i)?.[1]?.trim();
    const tsaTime = timeText ? new Date(timeText) : null;
    if (!tsaTime || !Number.isFinite(tsaTime.getTime())) throw new Error('FreeTSA response has no valid genTime');

    await run('openssl', ['ts', '-reply', '-in', replyPath, '-token_out', '-out', tokenPath]);
    const certificates = await run('openssl', ['pkcs7', '-inform', 'DER', '-in', tokenPath, '-print_certs']);
    const pem = certificates.stdout.toString('utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0];
    if (!pem) throw new Error('FreeTSA signing certificate is missing');
    const certificate = new X509Certificate(pem);
    return { tsaTime: tsaTime.toISOString(), certificateFingerprint: certificate.fingerprint256.replaceAll(':', '').toLowerCase() };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function createBatch(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pending = await client.query(
      `SELECT p.id,p.content_hash,r.kickoff
       FROM prediction_seal_proofs p JOIN prediction_runs r ON r.id=p.run_id
       WHERE p.batch_id IS NULL AND p.status='pending' AND r.kickoff>now()
       ORDER BY p.created_at FOR UPDATE OF p SKIP LOCKED LIMIT $1`,
      [BATCH_SIZE],
    );
    if (!pending.rows.length) { await client.query('COMMIT'); return null; }
    const tree = buildMerkleTree(pending.rows.map((row) => row.content_hash));
    const root = tree.root.toString('hex');
    const request = buildRfc3161Request(tree.root);
    const batch = await client.query(
      `INSERT INTO prediction_seal_batches(merkle_root,leaf_count,request_tsq,status,next_attempt_at)
       VALUES($1,$2,$3,'pending',now()) RETURNING id`,
      [root, pending.rows.length, request],
    );
    for (let index = 0; index < pending.rows.length; index++) {
      await client.query(
        `UPDATE prediction_seal_proofs SET batch_id=$1,leaf_index=$2,merkle_path=$3::jsonb,updated_at=now()
         WHERE id=$4`,
        [batch.rows[0].id, index, JSON.stringify(tree.paths[index]), pending.rows[index].id],
      );
    }
    await client.query('COMMIT');
    return Number(batch.rows[0].id);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function backfillPendingPredictionSealProofs(pool = pgPool, limit = 100) {
  const { rows } = await pool.query(
    `SELECT r.id AS run_id,r.sport,r.fixture_id,r.predicted_at,r.kickoff,r.data_cutoff,
       r.model_version,r.analysis_version,o.id AS market_output_id,o.market_key,o.market_family,o.output
     FROM prediction_runs r
     JOIN prediction_market_outputs o ON o.run_id=r.id AND o.is_recommendation=TRUE
     LEFT JOIN prediction_seal_proofs p ON p.market_output_id=o.id
     WHERE p.id IS NULL AND r.predicted_at<r.kickoff AND r.kickoff>now()
     ORDER BY r.kickoff,r.predicted_at LIMIT $1`,
    [Math.max(1, Math.min(500, Number(limit) || 100))],
  );
  let inserted = 0;
  for (const row of rows) {
    const canonical = canonicalJsonBytes(recommendationSealPayload({
      run: {
        sport: row.sport, fixtureId: row.fixture_id, predictedAt: row.predicted_at,
        kickoff: row.kickoff, dataCutoff: row.data_cutoff, modelVersion: row.model_version,
        analysisVersion: row.analysis_version,
      },
      output: { key: row.market_key, family: row.market_family, output: row.output },
    }));
    const result = await pool.query(
      `INSERT INTO prediction_seal_proofs(run_id,market_output_id,canonical_payload,content_hash,status)
       VALUES($1,$2,$3,$4,'pending') ON CONFLICT(market_output_id) DO NOTHING`,
      [row.run_id, row.market_output_id, canonical, sha512Hex(canonical)],
    );
    inserted += result.rowCount || 0;
  }
  return inserted;
}

async function claimBatch(pool) {
  const { rows } = await pool.query(
    `UPDATE prediction_seal_batches SET attempts=attempts+1,next_attempt_at=now()+interval '10 minutes',updated_at=now()
     WHERE id=(SELECT id FROM prediction_seal_batches
       WHERE status IN ('pending','failed') AND next_attempt_at<=now() AND attempts<8
       ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING *`,
  );
  return rows[0] || null;
}

async function markFailed(pool, batch, error) {
  const delayMinutes = Math.min(360, 5 * (2 ** Math.max(0, Number(batch.attempts) - 1)));
  const message = String(error?.message || error).slice(0, 1500);
  await pool.query(
    `UPDATE prediction_seal_batches SET status='failed',last_error=$2,next_attempt_at=now()+($3||' minutes')::interval,updated_at=now() WHERE id=$1`,
    [batch.id, message, delayMinutes],
  );
  await pool.query(`UPDATE prediction_seal_proofs SET status='failed',updated_at=now() WHERE batch_id=$1 AND status<>'sealed'`, [batch.id]);
}

export async function processPendingPredictionSeals(pool = pgPool, options = {}) {
  await backfillPendingPredictionSealProofs(pool);
  let batch = await claimBatch(pool);
  if (!batch) {
    const created = await createBatch(pool);
    if (!created) return { processed: 0, reason: 'empty' };
    batch = await claimBatch(pool);
  }
  if (!batch) return { processed: 0, reason: 'claimed-elsewhere' };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || 20_000));
    let response;
    try {
      response = await fetch(options.providerUrl || process.env.FREETSA_URL || DEFAULT_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/timestamp-query', Accept: 'application/timestamp-reply' },
        body: batch.request_tsq, signal: controller.signal,
      });
    } finally { clearTimeout(timeout); }
    if (!response.ok) throw new Error(`FreeTSA HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_RESPONSE_BYTES) throw new Error('FreeTSA returned an invalid response size');
    const verified = await verifyTsrArtifacts({ request: batch.request_tsq, response: bytes, expectedRoot: batch.merkle_root });
    const { rows: kickoffs } = await pool.query(
      `SELECT min(r.kickoff) AS first_kickoff FROM prediction_seal_proofs p JOIN prediction_runs r ON r.id=p.run_id WHERE p.batch_id=$1`,
      [batch.id],
    );
    if (new Date(verified.tsaTime) >= new Date(kickoffs[0].first_kickoff)) {
      await pool.query(
        `UPDATE prediction_seal_batches SET status='invalid',response_tsr=$2,tsa_time=$3,last_error='timestamp_not_before_kickoff',updated_at=now() WHERE id=$1`,
        [batch.id, bytes, verified.tsaTime],
      );
      await pool.query(`UPDATE prediction_seal_proofs SET status='invalid',updated_at=now() WHERE batch_id=$1`, [batch.id]);
      return { processed: batch.leaf_count, status: 'invalid' };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE prediction_seal_batches SET status='sealed',response_tsr=$2,submitted_at=now(),tsa_time=$3,
          verified_at=now(),certificate_fingerprint=$4,last_error=NULL,updated_at=now() WHERE id=$1`,
        [batch.id, bytes, verified.tsaTime, verified.certificateFingerprint],
      );
      await client.query(`UPDATE prediction_seal_proofs SET status='sealed',updated_at=now() WHERE batch_id=$1`, [batch.id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
    return { processed: batch.leaf_count, status: 'sealed', tsaTime: verified.tsaTime };
  } catch (error) {
    await markFailed(pool, batch, error);
    return { processed: batch.leaf_count, status: 'failed', error: String(error?.message || error) };
  }
}

export async function verifyStoredPredictionProof(row) {
  const canonical = Buffer.from(row.canonical_payload);
  const contentHash = sha512Hex(canonical);
  const hashValid = contentHash === row.content_hash;
  const merkleValid = hashValid && verifyMerkleProof(contentHash, row.merkle_path, row.merkle_root);
  if (!hashValid || !merkleValid) return { valid: false, hashValid, merkleValid, tsaValid: false };
  try {
    const tsa = await verifyTsrArtifacts({ request: row.request_tsq, response: row.response_tsr, expectedRoot: row.merkle_root });
    return { valid: new Date(tsa.tsaTime) < new Date(row.kickoff), hashValid, merkleValid, tsaValid: true, ...tsa };
  } catch (error) {
    return { valid: false, hashValid, merkleValid, tsaValid: false, error: String(error?.message || error) };
  }
}

export async function sealedProofsForFixtures(sport, fixtureIds, pool = pgPool) {
  const ids = [...new Set((fixtureIds || []).map(String).filter(Boolean))];
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (r.fixture_id,o.market_key)
       r.fixture_id,o.market_key,p.public_id,b.tsa_time,b.provider
     FROM prediction_seal_proofs p
     JOIN prediction_seal_batches b ON b.id=p.batch_id AND b.status='sealed'
     JOIN prediction_market_outputs o ON o.id=p.market_output_id
     JOIN prediction_runs r ON r.id=p.run_id
     WHERE r.sport=$1 AND r.fixture_id=ANY($2::text[]) AND p.status='sealed'
     ORDER BY r.fixture_id,o.market_key,r.predicted_at DESC`,
    [String(sport), ids],
  );
  const result = new Map();
  for (const row of rows) {
    if (!result.has(String(row.fixture_id))) result.set(String(row.fixture_id), new Map());
    result.get(String(row.fixture_id)).set(String(row.market_key), {
      status: 'sealed', publicId: row.public_id, provider: row.provider, sealedAt: row.tsa_time,
    });
  }
  return result;
}

export function attachSealsToRecommendationContainer(container, seals) {
  if (!container || !seals?.size) return container;
  const attach = (items) => Array.isArray(items)
    ? items.map((item) => seals.has(String(item?.id)) ? { ...item, seal: seals.get(String(item.id)) } : item)
    : items;
  return { ...container, selectable: attach(container.selectable), selections: attach(container.selections) };
}

export const predictionSealInternals = { verifyTsrArtifacts, createBatch };
