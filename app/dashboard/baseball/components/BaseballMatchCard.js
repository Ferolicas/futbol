'use client';

import Link from 'next/link';
import Image from 'next/image';

const cap = (v) => Math.min(95, Math.max(0, v ?? 0));

const isLive = (s) => ['LIVE', 'IN', 'IN1', 'IN2', 'IN3', 'IN4', 'IN5', 'IN6', 'IN7', 'IN8', 'IN9'].includes(s);
const isFinished = (s) => ['FT', 'AOT'].includes(s);
const isPostponed = (s) => ['POST', 'CANC', 'INTR', 'ABD'].includes(s);

function statusLabel(g) {
  const s = g?.status?.short || g?.status?.long;
  if (isLive(s)) {
    const inning = g?.status?.inning ?? '';
    const half = (g?.status?.long || '').toLowerCase();
    const arrow = half.includes('top') ? '↑' : half.includes('bottom') ? '↓' : '';
    return `${arrow}${inning}`.trim() || 'LIVE';
  }
  if (isFinished(s)) return 'FINAL';
  if (isPostponed(s)) return s === 'POST' ? 'Pospuesto' : s === 'CANC' ? 'Cancelado' : s;
  return 'NS';
}

function fmtTime(iso, tz = 'UTC') {
  if (!iso) return '–';
  try {
    return new Date(iso).toLocaleTimeString('es-ES', {
      hour: '2-digit', minute: '2-digit', timeZone: tz,
    });
  } catch {
    return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  }
}

function TeamRow({ team, score, hits, isWinner }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '4px 0',
      color: isWinner ? '#f1f5f9' : 'var(--text-secondary, #cbd5e1)',
      fontWeight: isWinner ? 700 : 500,
    }}>
      {team?.logo ? (
        <Image src={team.logo} alt={team.name} width={20} height={20} style={{ objectFit: 'contain' }} unoptimized />
      ) : (
        <span style={{ width: 20, height: 20, background: 'rgba(255,255,255,0.06)', borderRadius: 4 }} />
      )}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '.92rem' }}>{team?.name || '–'}</span>
      {score != null && (
        <span style={{ fontWeight: 800, color: isWinner ? '#f59e0b' : '#94a3b8', fontSize: '1.05rem', minWidth: 22, textAlign: 'right', fontFamily: 'JetBrains Mono, monospace' }}>{score}</span>
      )}
      {hits != null && (
        <span style={{ fontSize: '.7rem', color: 'rgba(245,158,11,0.6)', fontFamily: 'JetBrains Mono, monospace' }}>H:{hits}</span>
      )}
    </div>
  );
}

function CombinadaChip({ combinada }) {
  if (!combinada?.selections?.length) return null;
  const prob = combinada.combinedProbability;
  if (!prob || prob < 55) return null;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)',
      borderRadius: 100, padding: '2px 8px', fontSize: '.72rem', fontWeight: 700,
      color: '#f59e0b',
    }}>
      🎯 {prob.toFixed(0)}%{combinada.hasRealOdds && combinada.combinedOdd ? ` · @${combinada.combinedOdd}` : ''}
    </span>
  );
}

export default function BaseballMatchCard({
  game,
  onToggleFavorite,
  onHide,
  userTz = 'UTC',
}) {
  const fid = game.id;
  const status = game.status;
  const live = isLive(status?.short);
  const finished = isFinished(status?.short);

  const liveResult = game.liveResult;
  const homeScore = liveResult?.home_score ?? game.scores?.home?.total;
  const awayScore = liveResult?.away_score ?? game.scores?.away?.total;
  const homeHits = liveResult?.home_hits ?? null;
  const awayHits = liveResult?.away_hits ?? null;

  const hasScore = homeScore != null && awayScore != null && (live || finished);

  const home = game.teams?.home;
  const away = game.teams?.away;

  const probs = game.analysis?.probabilities;
  const ml = probs?.moneyline;
  const totals = probs?.totals;
  const combinada = game.analysis?.combinada;

  if (game.isHidden) return null;

  const liveColor = '#f59e0b';
  const accent = live ? liveColor : finished ? '#94a3b8' : '#22d3ee';

  return (
    <div
      className="match-card"
      style={{
        background: 'var(--surface, #0f172a)',
        border: live ? `1px solid ${liveColor}55` : '1px solid var(--border-subtle, rgba(255,255,255,0.06))',
        borderRadius: 14,
        padding: 12,
        position: 'relative',
        animation: live ? 'pulse 2s infinite' : undefined,
        transition: 'all .25s',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <button
          onClick={(e) => { e.preventDefault(); onToggleFavorite?.(fid); }}
          aria-label="Favorito"
          style={{
            width: 26, height: 26, borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.1)',
            background: game.isFavorite ? 'rgba(245,158,11,0.18)' : 'transparent',
            color: game.isFavorite ? '#f59e0b' : '#94a3b8',
            cursor: 'pointer', fontSize: 14,
          }}
        >
          ★
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <TeamRow team={home} score={hasScore ? homeScore : null} hits={hasScore ? homeHits : null}
            isWinner={finished && homeScore > awayScore} />
          <TeamRow team={away} score={hasScore ? awayScore : null} hits={hasScore ? awayHits : null}
            isWinner={finished && awayScore > homeScore} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, minWidth: 70 }}>
          <div style={{ fontSize: '.7rem', fontWeight: 800, color: accent, fontFamily: 'JetBrains Mono, monospace' }}>
            {statusLabel(game)}
          </div>
          {!hasScore && (
            <div style={{ fontSize: '.78rem', color: '#22d3ee', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
              {fmtTime(game.date, userTz)}
            </div>
          )}
        </div>
      </div>

      {/* Probability bar */}
      {ml && (
        <div style={{ display: 'flex', gap: 4, fontSize: '.78rem', margin: '6px 0', alignItems: 'center' }}>
          <span style={{ color: '#10b981', fontWeight: 700 }}>{cap(ml.home).toFixed(0)}%</span>
          <div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 4, overflow: 'hidden', display: 'flex' }}>
            <div style={{ width: `${cap(ml.home)}%`, background: '#10b981' }} />
            <div style={{ width: `${cap(ml.away)}%`, background: '#ef4444' }} />
          </div>
          <span style={{ color: '#ef4444', fontWeight: 700 }}>{cap(ml.away).toFixed(0)}%</span>
        </div>
      )}

      {/* Market chips */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
        {totals?.bestLine && totals.lines?.[totals.bestLine] && (
          <span style={{
            fontSize: '.7rem', padding: '2px 8px', borderRadius: 999,
            background: 'rgba(34,211,238,0.08)', color: '#22d3ee',
            fontWeight: 600, border: '1px solid rgba(34,211,238,0.18)',
          }}>
            O/U {totals.bestLine}: {Math.max(totals.lines[totals.bestLine].over, totals.lines[totals.bestLine].under)}%
          </span>
        )}
        {combinada && <CombinadaChip combinada={combinada} />}
      </div>

      {/* Footer */}
      <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center' }}>
        <div style={{ flex: 1 }} />
        {game.isAnalyzed && (
          <Link
            href={`/dashboard/baseball/analisis/${fid}`}
            style={{
              padding: '5px 12px', borderRadius: 6, fontSize: '.75rem', fontWeight: 700,
              background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)',
              color: '#f59e0b', textDecoration: 'none',
            }}
          >
            Ver análisis →
          </Link>
        )}
        <button
          onClick={() => onHide?.(fid, (game.date || '').split('T')[0])}
          aria-label="Ocultar"
          style={{
            width: 26, height: 26, borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.1)',
            background: 'transparent', color: '#94a3b8',
            cursor: 'pointer', fontSize: 12,
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
