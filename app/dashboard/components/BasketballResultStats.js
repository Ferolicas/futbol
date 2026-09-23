'use client';

// Marcador por cuarto (NBA/NCAA) — mismo patrón visual que BaseballResultStats
// (carreras por entrada), con los datos que ya captura nba-stats-api.js /
// espn-sports-api.js: game.periods.home/away, un array de puntos por cuarto.
const QUARTER_LABELS = ['C1', 'C2', 'C3', 'C4'];

export default function BasketballResultStats({ periods, homeName = 'Local', awayName = 'Visitante', compact = false }) {
  const home = Array.isArray(periods?.home) ? periods.home : [];
  const away = Array.isArray(periods?.away) ? periods.away : [];
  const count = Math.max(home.length, away.length);
  if (!count) return null;

  const teamLabel = (name, fallback) => {
    const parts = String(name || fallback).trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) return (parts[0] || fallback).slice(0, 3).toUpperCase();
    return parts.map((part) => part[0]).join('').slice(0, 3).toUpperCase();
  };
  const periodLabel = (index) => QUARTER_LABELS[index] || `OT${index - 3}`;
  const total = (values) => values.reduce((sum, value) => sum + (Number(value) || 0), 0);

  return (
    <div style={{
      marginTop: compact ? 9 : 0, padding: compact ? '8px 9px' : '10px 11px',
      borderRadius: 10, background: 'rgba(255,255,255,.025)',
      border: '1px solid rgba(94,230,177,.12)', overflowX: 'auto',
    }}>
      <div style={{ minWidth: Math.max(220, 58 + count * 34) }}>
        <div style={{ display: 'grid', gridTemplateColumns: `minmax(54px,1.25fr) repeat(${count},34px) 38px`, gap: 4, alignItems: 'center', marginBottom: 4 }}>
          <span />
          {Array.from({ length: count }, (_, i) => (
            <abbr key={i} style={{ textDecoration: 'none', textAlign: 'center', color: '#64748b', fontSize: '.57rem', fontWeight: 900 }}>{periodLabel(i)}</abbr>
          ))}
          <abbr style={{ textDecoration: 'none', textAlign: 'center', color: '#64748b', fontSize: '.57rem', fontWeight: 900 }}>TOT</abbr>
        </div>
        {[
          { key: 'home', name: homeName, fallback: 'LOC', values: home, color: '#67e8f9' },
          { key: 'away', name: awayName, fallback: 'VIS', values: away, color: '#fcd34d' },
        ].map((team) => (
          <div key={team.key} style={{ display: 'grid', gridTemplateColumns: `minmax(54px,1.25fr) repeat(${count},34px) 38px`, gap: 4, alignItems: 'center', padding: '3px 0' }}>
            <strong title={team.name} style={{ color: team.color, fontSize: '.62rem' }}>{teamLabel(team.name, team.fallback)}</strong>
            {Array.from({ length: count }, (_, i) => (
              <span key={i} style={{ textAlign: 'center', color: '#e2e8f0', fontSize: '.72rem', fontWeight: 800, fontFamily: 'JetBrains Mono, monospace' }}>
                {team.values[i] ?? '—'}
              </span>
            ))}
            <span style={{ textAlign: 'center', color: '#5ee6b1', fontSize: '.74rem', fontWeight: 900, fontFamily: 'JetBrains Mono, monospace' }}>{total(team.values)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
