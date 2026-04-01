'use client';

const STATUS_CONFIG = {
  '1H':   { label: '1T', cls: 'badge-live', live: true },
  '2H':   { label: '2T', cls: 'badge-live', live: true },
  'HT':   { label: 'DESC', cls: 'badge-ht', live: false },
  'ET':   { label: 'PRÓRROGA', cls: 'badge-live', live: true },
  'BT':   { label: 'DESCANSO P', cls: 'badge-ht', live: false },
  'P':    { label: 'PENALES', cls: 'badge-live', live: true },
  'LIVE': { label: 'EN VIVO', cls: 'badge-live', live: true },
  'FT':   { label: 'FINALIZADO', cls: 'badge-ft', live: false },
  'AET':  { label: 'FT (PRÓRROGA)', cls: 'badge-ft', live: false },
  'PEN':  { label: 'FT (PENALES)', cls: 'badge-ft', live: false },
  'NS':   { label: 'NO INICIADO', cls: 'badge-ns', live: false },
  'PST':  { label: 'POSPUESTO', cls: 'badge-ft', live: false },
  'CANC': { label: 'CANCELADO', cls: 'badge-ft', live: false },
  'TBD':  { label: 'POR DEFINIR', cls: 'badge-ns', live: false },
};

export default function MatchStatusBadge({ status, elapsed }) {
  const s = status?.short || 'NS';
  const config = STATUS_CONFIG[s] || { label: s, cls: 'badge-ft', live: false };
  const displayElapsed = config.live && elapsed ? `${elapsed}'` : null;

  return (
    <span className={`badge ${config.cls}`}>
      {config.live && <span className="live-dot" />}
      {displayElapsed || config.label}
    </span>
  );
}
