const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:1/cfanalisis_test';
process.env.DATABASE_SSL ||= 'false';

test('JSON canónico y SHA-512 son deterministas y conservan UTF-8 exacto', async () => {
  const { canonicalJson, canonicalJsonBytes, sha512Hex } = await import('../lib/prediction-seal-core.js');
  const left = { z: 'Fútbol', nested: { b: 2, a: true }, list: [{ y: 1, x: 0 }] };
  const right = { list: [{ x: -0, y: 1 }], nested: { a: true, b: 2 }, z: 'Fútbol' };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(sha512Hex(canonicalJsonBytes(left)), sha512Hex(canonicalJsonBytes(right)));
  assert.equal(sha512Hex(canonicalJsonBytes(left)).length, 128);
});
test('Merkle prueba cada recomendación y rechaza contenido o camino alterado', async () => {
  const { buildMerkleTree, sha512, verifyMerkleProof } = await import('../lib/prediction-seal-core.js');
  const leaves = ['uno', 'dos', 'tres'].map((value) => sha512(Buffer.from(value)));
  const tree = buildMerkleTree(leaves);
  leaves.forEach((leaf, index) => assert.equal(verifyMerkleProof(leaf, tree.paths[index], tree.root), true));
  assert.equal(verifyMerkleProof(sha512(Buffer.from('manipulado')), tree.paths[0], tree.root), false);
  const badPath = structuredClone(tree.paths[1]);
  badPath[0].hash = '00'.repeat(64);
  assert.equal(verifyMerkleProof(leaves[1], badPath, tree.root), false);
});

test('verifica criptográficamente un TSR real de FreeTSA y rechaza otro imprint', async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/freetsa-sample.json'), 'utf8'));
  const { predictionSealInternals } = await import('../lib/prediction-seal.js');
  const valid = await predictionSealInternals.verifyTsrArtifacts({
    request: Buffer.from(fixture.request, 'base64'), response: Buffer.from(fixture.response, 'base64'), expectedRoot: fixture.root,
  });
  assert.match(valid.certificateFingerprint, /^[0-9a-f]{64}$/);
  assert.ok(Number.isFinite(new Date(valid.tsaTime).getTime()));
  await assert.rejects(() => predictionSealInternals.verifyTsrArtifacts({
    request: Buffer.from(fixture.request, 'base64'), response: Buffer.from(fixture.response, 'base64'), expectedRoot: 'ff'.repeat(64),
  }), /imprint/i);
});

test('el fixture RFC 3161 generado solicita SHA-512 y certificados', async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/freetsa-sample.json'), 'utf8'));
  const { buildRfc3161Request } = await import('../lib/prediction-seal.js');
  assert.equal(buildRfc3161Request(fixture.root).toString('base64'), fixture.request);
});
