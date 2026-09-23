'use client';

const valueOrDash = (value) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value);

function diamondBase(occupied, top, left) {
  return {
    position: 'absolute', top, left, transform: 'translate(-50%,-50%) rotate(45deg)',
    width: 12, height: 12,
    background: occupied ? '#5ee6b1' : 'rgba(255,255,255,.15)',
    border: occupied ? '1px solid #5ee6b1' : '1px solid rgba(255,255,255,.25)',
    boxShadow: occupied ? '0 0 8px rgba(94,230,177,.6)' : 'none',
  };
}

// Diamante con corredores en base + conteo (bolas-strikes) + outs + entrada.
// Usa el estado pitch-by-pitch que getMlbLiveGame ya trae (bases/balls/
// strikes/outs/inning/inning_half) — antes se calculaba pero nunca se
// persistía ni se mostraba en ningún lado.
export function LiveDiamond({ live }) {
  if (!live) return null;
  const b = live.bases || {};
  const hasCount = live.balls != null || live.strikes != null || live.outs != null;
  if (!hasCount && !b.first && !b.second && !b.third) return null;
  const balls = live.balls ?? 0;
  const strikes = live.strikes ?? 0;
  const outs = live.outs ?? 0;
  const arrow = live.inning_half === 'top' ? '↑' : live.inning_half === 'bottom' ? '↓' : '';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 8, padding: '8px 12px', borderRadius: 8, background: 'rgba(94,230,177,0.06)', border: '1px solid rgba(94,230,177,0.16)' }}>
      <div style={{ position: 'relative', width: 40, height: 40, flexShrink: 0 }}>
        <span style={diamondBase(b.second, '50%', '22%')} />
        <span style={diamondBase(b.third, '22%', '50%')} />
        <span style={diamondBase(b.first, '78%', '50%')} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontFamily: 'JetBrains Mono, monospace' }}>
        <span style={{ fontSize: '.72rem', color: '#5ee6b1', fontWeight: 800 }}>
          {arrow}{live.inning ?? ''}  ·  {balls}-{strikes}
        </span>
        <span style={{ fontSize: '.64rem', color: '#bff4df', letterSpacing: 1 }}>
          {'●'.repeat(Math.min(outs, 3))}{'○'.repeat(Math.max(0, 2 - outs))} outs
        </span>
      </div>
      {(live.currentPitcher?.name || live.currentBatter?.name) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: '.62rem', color: '#94a3b8', minWidth: 0, flex: 1 }}>
          {live.currentPitcher?.name && <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>⚾ {live.currentPitcher.name}</span>}
          {live.currentBatter?.name && <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>🏏 {live.currentBatter.name}</span>}
        </div>
      )}
    </div>
  );
}

export default function BaseballResultStats({
  result,
  homeName = 'Local',
  awayName = 'Visitante',
  compact = false,
}) {
  if (!result) return null;
  const homeStats = result.home_stats || {};
  const awayStats = result.away_stats || {};
  const metrics = [
    { key: 'hits', short: 'H', label: 'Hits', home: result.home_hits ?? homeStats.hits, away: result.away_hits ?? awayStats.hits },
    { key: 'homeRuns', short: 'HR', label: 'Jonrones', home: homeStats.homeRuns, away: awayStats.homeRuns },
    { key: 'errors', short: 'E', label: 'Errores', home: result.home_errors ?? homeStats.errors, away: result.away_errors ?? awayStats.errors },
    { key: 'walks', short: 'BB', label: 'Bases por bolas', home: homeStats.walks, away: awayStats.walks },
    { key: 'strikeouts', short: 'K', label: 'Ponches al bate', home: homeStats.strikeouts, away: awayStats.strikeouts },
    { key: 'leftOnBase', short: 'LOB', label: 'Dejados en base', home: homeStats.leftOnBase, away: awayStats.leftOnBase },
    ...(!compact ? [
      { key: 'doubles', short: '2B', label: 'Dobles', home: homeStats.doubles, away: awayStats.doubles },
      { key: 'triples', short: '3B', label: 'Triples', home: homeStats.triples, away: awayStats.triples },
      { key: 'totalBases', short: 'TB', label: 'Bases totales', home: homeStats.totalBases, away: awayStats.totalBases },
      { key: 'rbis', short: 'RBI', label: 'Carreras impulsadas', home: homeStats.rbis, away: awayStats.rbis },
      { key: 'atBats', short: 'AB', label: 'Turnos al bate', home: homeStats.atBats, away: awayStats.atBats },
      { key: 'stolenBases', short: 'BR', label: 'Bases robadas', home: homeStats.stolenBases, away: awayStats.stolenBases },
    ] : []),
  ].filter((metric) => metric.home != null || metric.away != null);

  const innings = Array.isArray(result.innings) ? result.innings : [];
  if (!metrics.length && (!innings.length || compact)) return null;
  const teamLabel = (name, fallback) => {
    const parts = String(name || fallback).trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) return (parts[0] || fallback).slice(0, 3).toUpperCase();
    return parts.map((part) => part[0]).join('').slice(0, 3).toUpperCase();
  };
  const columns = `minmax(54px,1.25fr) repeat(${Math.max(1, metrics.length)},minmax(34px,1fr))`;

  return (
    <div style={{
      marginTop: compact ? 9 : 0, padding: compact ? '8px 9px' : '10px 11px',
      borderRadius: 10, background: 'rgba(255,255,255,.025)',
      border: '1px solid rgba(94,230,177,.12)', overflowX: 'auto',
    }}>
      {metrics.length > 0 && (
        <div style={{ minWidth: compact ? 270 : 430 }}>
          <div style={{ display: 'grid', gridTemplateColumns: columns, gap: 4, alignItems: 'center', marginBottom: 4 }}>
            <span />
            {metrics.map((metric) => (
              <abbr key={metric.key} title={metric.label} style={{ textDecoration: 'none', textAlign: 'center', color: '#64748b', fontSize: '.57rem', fontWeight: 900 }}>
                {metric.short}
              </abbr>
            ))}
          </div>
          {[
            { key: 'home', name: homeName, fallback: 'LOC', values: metrics.map((metric) => metric.home) },
            { key: 'away', name: awayName, fallback: 'VIS', values: metrics.map((metric) => metric.away) },
          ].map((team) => (
            <div key={team.key} style={{ display: 'grid', gridTemplateColumns: columns, gap: 4, alignItems: 'center', padding: '3px 0' }}>
              <strong title={team.name} style={{ color: team.key === 'home' ? '#67e8f9' : '#fcd34d', fontSize: '.62rem' }}>
                {teamLabel(team.name, team.fallback)}
              </strong>
              {team.values.map((value, index) => (
                <span key={metrics[index].key} style={{ textAlign: 'center', color: '#e2e8f0', fontSize: '.72rem', fontWeight: 800, fontFamily: 'JetBrains Mono, monospace' }}>
                  {valueOrDash(value)}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      {!compact && innings.length > 0 && (
        <div style={{ marginTop: metrics.length ? 12 : 0 }}>
          <div style={{ color: '#94a3b8', fontSize: '.66rem', fontWeight: 800, marginBottom: 6 }}>CARRERAS POR ENTRADA</div>
          <div style={{ minWidth: Math.max(300, 62 + innings.length * 34) }}>
            {[
              { key: 'head', label: '', values: innings.map((inning) => inning.number ?? inning.num) },
              { key: 'home', label: teamLabel(homeName, 'LOC'), values: innings.map((inning) => inning.home) },
              { key: 'away', label: teamLabel(awayName, 'VIS'), values: innings.map((inning) => inning.away) },
            ].map((row) => (
              <div key={row.key} style={{ display: 'grid', gridTemplateColumns: `54px repeat(${innings.length},34px)`, gap: 3, padding: '2px 0' }}>
                <strong style={{ color: '#94a3b8', fontSize: '.6rem' }}>{row.label}</strong>
                {row.values.map((value, index) => (
                  <span key={`${row.key}-${index}`} style={{ textAlign: 'center', color: row.key === 'head' ? '#64748b' : '#e2e8f0', fontSize: '.66rem', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>
                    {valueOrDash(value)}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
