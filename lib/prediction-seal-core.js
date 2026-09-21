import crypto from 'node:crypto';

function normalize(value, inArray = false) {
  if (value === undefined) return inArray ? null : undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON only accepts finite numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalize(item, true));
  if (typeof value !== 'object') throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const item = normalize(value[key], false);
    if (item !== undefined) out[key] = item;
  }
  return out;
}
export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

export function canonicalJsonBytes(value) {
  return Buffer.from(canonicalJson(value), 'utf8');
}

export function sha512(value) {
  return crypto.createHash('sha512').update(value).digest();
}

export function sha512Hex(value) {
  return sha512(value).toString('hex');
}

function nodeHash(left, right) {
  return sha512(Buffer.concat([Buffer.from([1]), left, right]));
}

export function buildMerkleTree(hashValues) {
  if (!Array.isArray(hashValues) || hashValues.length === 0) throw new TypeError('At least one leaf is required');
  const leaves = hashValues.map((value) => Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'hex'));
  if (leaves.some((leaf) => leaf.length !== 64)) throw new TypeError('Merkle leaves must be SHA-512 hashes');
  const paths = leaves.map(() => []);
  let layer = leaves.map((hash, index) => ({ hash, indexes: [index] }));
  while (layer.length > 1) {
    const next = [];
    for (let index = 0; index < layer.length; index += 2) {
      const left = layer[index];
      const right = layer[index + 1] || left;
      for (const leafIndex of left.indexes) paths[leafIndex].push({ side: 'right', hash: right.hash.toString('hex') });
      if (right !== left) for (const leafIndex of right.indexes) paths[leafIndex].push({ side: 'left', hash: left.hash.toString('hex') });
      next.push({ hash: nodeHash(left.hash, right.hash), indexes: [...left.indexes, ...(right === left ? [] : right.indexes)] });
    }
    layer = next;
  }
  return { root: layer[0].hash, paths };
}

export function verifyMerkleProof(leafHash, path, expectedRoot) {
  let current = Buffer.isBuffer(leafHash) ? Buffer.from(leafHash) : Buffer.from(leafHash, 'hex');
  for (const step of path || []) {
    const sibling = Buffer.from(step.hash, 'hex');
    if (sibling.length !== 64 || !['left', 'right'].includes(step.side)) return false;
    current = step.side === 'left' ? nodeHash(sibling, current) : nodeHash(current, sibling);
  }
  const root = Buffer.isBuffer(expectedRoot) ? expectedRoot : Buffer.from(expectedRoot, 'hex');
  return current.length === root.length && crypto.timingSafeEqual(current, root);
}

export function recommendationSealPayload({ run, output }) {
  return {
    schema: 'cfanalisis.prediction-seal.v1',
    sport: String(run.sport),
    fixtureId: String(run.fixtureId),
    marketKey: String(output.key),
    predictedAt: run.predictedAt,
    kickoff: run.kickoff,
    dataCutoff: run.dataCutoff,
    modelVersion: run.modelVersion || null,
    analysisVersion: Number(run.analysisVersion || 0),
    recommendation: output.output,
  };
}
