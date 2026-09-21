import { pgPool } from '../../../../lib/db';
import { verifyStoredPredictionProof } from '../../../../lib/prediction-seal';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(_request, props) {
  const { id } = await props.params;
  if (!UUID.test(id || '')) return Response.json({ error: 'Prueba no válida' }, { status: 400 });
  const { rows } = await pgPool.query(
    `SELECT p.id,p.public_id,p.canonical_payload,p.content_hash,p.merkle_path,p.leaf_index,p.status,
            r.sport,r.fixture_id,r.kickoff,o.market_key,
            b.id AS batch_id,b.provider,b.provider_url,b.merkle_root,b.request_tsq,b.response_tsr,
            b.tsa_time,b.verified_at,b.certificate_fingerprint,b.status AS batch_status
     FROM prediction_seal_proofs p
     JOIN prediction_runs r ON r.id=p.run_id
     JOIN prediction_market_outputs o ON o.id=p.market_output_id
     JOIN prediction_seal_batches b ON b.id=p.batch_id
     WHERE p.public_id=$1 AND p.status='sealed' AND b.status='sealed'`,
    [id],
  );
  const row = rows[0];
  if (!row) return Response.json({ error: 'Prueba no encontrada' }, { status: 404 });
  const verification = await verifyStoredPredictionProof(row);
  if (!verification.valid) {
    await pgPool.query(`UPDATE prediction_seal_proofs SET status='invalid',updated_at=now() WHERE id=$1`, [row.id]).catch(() => {});
    return Response.json({
      id: row.public_id, status: 'invalid', integrityVerified: false,
      provider: row.provider, sealedAt: row.tsa_time,
    }, { status: 409, headers: { 'Cache-Control': 'public, max-age=60' } });
  }
  const contentRedacted = Date.now() < new Date(row.kickoff).getTime();
  const technical = {
    algorithm: 'SHA-512',
    contentHash: row.content_hash,
    merkleRoot: row.merkle_root,
    leafIndex: row.leaf_index,
    merklePath: row.merkle_path,
    certificateFingerprint: row.certificate_fingerprint,
    ...(contentRedacted ? {} : {
      canonicalJson: Buffer.from(row.canonical_payload).toString('utf8'),
      requestTsqBase64: Buffer.from(row.request_tsq).toString('base64'),
      responseTsrBase64: Buffer.from(row.response_tsr).toString('base64'),
    }),
  };
  return Response.json({
    id: row.public_id,
    status: 'sealed',
    provider: row.provider,
    providerUrl: row.provider_url,
    sealedAt: verification.tsaTime,
    kickoff: row.kickoff,
    integrityVerified: true,
    checks: { canonicalHash: verification.hashValid, merkleInclusion: verification.merkleValid, rfc3161Signature: verification.tsaValid },
    contentRedacted,
    technical,
  }, { headers: { 'Cache-Control': contentRedacted ? 'public, max-age=60' : 'public, max-age=3600, immutable' } });
}
