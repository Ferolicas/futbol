'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export default function PredictionSealBadge({ seal }) {
  const [open, setOpen] = useState(false);
  const [proof, setProof] = useState(null);
  const [error, setError] = useState('');
  const [technical, setTechnical] = useState(false);
  useEffect(() => {
    if (!open || proof || !seal?.publicId) return;
    let active = true;
    fetch(`/api/verificar-pronostico/${encodeURIComponent(seal.publicId)}`, { cache: 'no-store' })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error || 'No se pudo verificar la prueba');
        if (active) setProof(json);
      })
      .catch((reason) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [open, proof, seal?.publicId]);
  if (seal?.status !== 'sealed' || !seal.publicId) return null;
  const trigger = (event) => { event.preventDefault(); event.stopPropagation(); setOpen(true); };
  return <>
    <span className="prediction-seal-badge" role="button" tabIndex={0} onClick={trigger}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') trigger(event); }}>
      ✓ Sellado externamente
    </span>
    {open && typeof document !== 'undefined' && createPortal(
      <div className="prediction-seal-overlay" role="presentation" onMouseDown={() => setOpen(false)}>
        <section className="prediction-seal-modal" role="dialog" aria-modal="true" aria-labelledby="prediction-seal-title" onMouseDown={(event) => event.stopPropagation()}>
          <button type="button" className="prediction-seal-close" onClick={() => setOpen(false)} aria-label="Cerrar">×</button>
          <small>Prueba independiente RFC 3161</small>
          <h3 id="prediction-seal-title">Pronóstico sellado antes del partido</h3>
          {!proof && !error && <p>Verificando firma, hash y prueba Merkle…</p>}
          {error && <p className="prediction-seal-error">{error}</p>}
          {proof && <>
            <dl>
              <div><dt>Fecha del sello</dt><dd>{new Date(proof.sealedAt).toLocaleString('es-ES')}</dd></div>
              <div><dt>Proveedor</dt><dd>{proof.provider}</dd></div>
              <div><dt>Integridad</dt><dd className="is-valid">✓ Verificada criptográficamente</dd></div>
            </dl>
            {proof.contentRedacted && <p className="prediction-seal-note">El contenido técnico permanece oculto hasta que empiece el partido para proteger los pronósticos Premium.</p>}
            <button type="button" className="prediction-seal-technical-button" onClick={() => setTechnical((value) => !value)}>Ver prueba técnica</button>
            {technical && <div className="prediction-seal-technical">
              <code>SHA-512: {proof.technical.contentHash}</code>
              <code>Merkle root: {proof.technical.merkleRoot}</code>
              <code>Certificado: {proof.technical.certificateFingerprint}</code>
              <p>Hash canónico: ✓ · Inclusión Merkle: ✓ · Firma RFC 3161: ✓</p>
              {!proof.technical.canonicalJson && <p>Los bytes canónicos y el TSR estarán disponibles después del inicio.</p>}
              {proof.technical.canonicalJson && <details><summary>JSON canónico</summary><pre>{proof.technical.canonicalJson}</pre></details>}
            </div>}
          </>}
        </section>
      </div>, document.body)}
  </>;
}
