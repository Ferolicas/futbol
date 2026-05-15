'use client';

import { useEffect, useState } from 'react';

/**
 * /ferney/audit — vista basica de audit_logs.
 *
 * Tabla con las ultimas 50 acciones administrativas. Sin filtros aun;
 * cuando crezca el volumen, ampliar con paginacion y filtro por
 * action/user.
 */
export default function AuditPage() {
  const [logs, setLogs] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/audit-logs?limit=50', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { if (!cancelled) setLogs(Array.isArray(d?.logs) ? d.logs : []); })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div style={{ padding: 20, color: '#f1f5f9', maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: 16 }}>Audit log</h1>
      <p style={{ fontSize: '.85rem', color: '#94a3b8', marginBottom: 16 }}>
        Ultimas 50 acciones administrativas. Si la tabla audit_logs aun no
        existe en el VPS, esta vista mostrara vacia — ejecuta scripts/migrate-audit-logs.sql.
      </p>

      {error && (
        <div style={{ padding: 12, background: '#3a1010', borderRadius: 8, color: '#fca5a5' }}>
          Error: {error}
        </div>
      )}

      {logs === null && <div style={{ color: '#94a3b8' }}>Cargando…</div>}

      {Array.isArray(logs) && logs.length === 0 && (
        <div style={{ color: '#94a3b8' }}>Sin registros.</div>
      )}

      {Array.isArray(logs) && logs.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #1c1c2a', color: '#94a3b8' }}>
                <th style={{ textAlign: 'left', padding: '8px 6px' }}>Fecha (UTC)</th>
                <th style={{ textAlign: 'left', padding: '8px 6px' }}>Usuario</th>
                <th style={{ textAlign: 'left', padding: '8px 6px' }}>Accion</th>
                <th style={{ textAlign: 'left', padding: '8px 6px' }}>Entidad</th>
                <th style={{ textAlign: 'left', padding: '8px 6px' }}>ID</th>
                <th style={{ textAlign: 'left', padding: '8px 6px' }}>IP</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(row => (
                <tr key={row.id} style={{ borderBottom: '1px solid #1a1a26' }}>
                  <td style={{ padding: '8px 6px', whiteSpace: 'nowrap', color: '#cbd5e1' }}>
                    {row.created_at?.replace('T', ' ').split('.')[0] || ''}
                  </td>
                  <td style={{ padding: '8px 6px', color: '#cbd5e1' }}>{row.user_email || '—'}</td>
                  <td style={{ padding: '8px 6px', fontWeight: 600, color: '#67e8f9' }}>{row.action}</td>
                  <td style={{ padding: '8px 6px', color: '#cbd5e1' }}>{row.entity || '—'}</td>
                  <td style={{ padding: '8px 6px', color: '#94a3b8', fontFamily: 'monospace', fontSize: '.78rem' }}>
                    {row.entity_id || '—'}
                  </td>
                  <td style={{ padding: '8px 6px', color: '#64748b', fontFamily: 'monospace', fontSize: '.78rem' }}>
                    {row.ip || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
