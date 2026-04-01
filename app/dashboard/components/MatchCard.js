'use client';
import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import FavoriteStar from './FavoriteStar';
import MatchStatusBadge from './MatchStatusBadge';
import { fmtTimeInTz } from '../../../lib/timezone';

function TeamRow({ team, score, isWinner }) {
  return (
    <div className="match-team" style={isWinner ? { color: '#f1f5f9', fontWeight: 700 } : {}}>
      {team?.logo ? (
        <Image src={team.logo} alt={team.name} width={20} height={20} style={{ objectFit: 'contain', flexShrink: 0 }} unoptimized />
      ) : (
        <span style={{ width: 20, height: 20, background: 'rgba(255,255,255,0.06)', borderRadius: 4, flexShrink: 0, display: 'inline-block' }} />
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{team?.name || '–'}</span>
    </div>
  );
}

function LiveStats({ liveData }) {
  if (!liveData?.stats) return null;
  const { home, away } = liveData.stats;
  const items = [];

  const totalCorners = (home?.corners ?? 0) + (away?.corners ?? 0);
  if (totalCorners > 0) {
    items.push(<span key="c" className="stat-item"><span className="stat-icon">📐</span>{home?.corners ?? 0}-{away?.corners ?? 0}</span>);
  }
  const totalYellow = (home?.yellowCards ?? 0) + (away?.yellowCards ?? 0);
  if (totalYellow > 0) {
    items.push(<span key="y" className="stat-item"><span className="stat-icon">🟨</span>{home?.yellowCards ?? 0}-{away?.yellowCards ?? 0}</span>);
  }
  if (home?.redCards > 0 || away?.redCards > 0) {
    items.push(<span key="r" className="stat-item"><span className="stat-icon">🟥</span>{home?.redCards ?? 0}-{away?.redCards ?? 0}</span>);
  }
  const shots = (home?.shotsOnTarget ?? 0) + (away?.shotsOnTarget ?? 0);
  if (shots > 0) {
    items.push(<span key="s" className="stat-item"><span className="stat-icon">⚽</span>{home?.shotsOnTarget ?? 0}-{away?.shotsOnTarget ?? 0} a puerta</span>);
  }

  if (items.length === 0) return null;
  return <div className="match-stats-row">{items}</div>;
}

function GoalScorers({ events }) {
  if (!events?.length) return null;
  const goals = events.filter(e => e.type === 'Goal' && e.detail !== 'Missed Penalty');
  if (!goals.length) return null;

  return (
    <div className="match-stats-row" style={{ fontSize: '.75rem', color: 'var(--text-muted)', gap: '.5rem', flexWrap: 'wrap' }}>
      {goals.slice(0, 5).map((g, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          ⚽ <span style={{ color: 'var(--text-secondary)' }}>{g.player?.name?.split(' ').pop() || '?'}</span>
          <span style={{ color: 'var(--accent-cyan)', fontFamily: 'JetBrains Mono, monospace', fontSize: '.7rem' }}>{g.time?.elapsed}'</span>
        </span>
      ))}
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
      background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)',
      borderRadius: 100, padding: '2px 8px', fontSize: '.72rem', fontWeight: 700,
      color: 'var(--accent-green)',
    }}>
      🎯 {prob.toFixed(0)}%{combinada.hasRealOdds && combinada.combinedOdd ? ` · @${combinada.combinedOdd}` : ''}
    </span>
  );
}

export default function MatchCard({
  fixture,
  liveData,
  analysis,
  isAnalyzed,
  isFavorite,
  isHidden,
  onToggleFavorite,
  onHide,
  userTz = 'UTC',
  style,
}) {
  const [expanded, setExpanded] = useState(false);
  const fid = fixture?.fixture?.id;
  const status = fixture?.fixture?.status;
  const isLive = ['1H','2H','HT','ET','P','BT','LIVE'].includes(status?.short);
  const isFinished = ['FT','AET','PEN'].includes(status?.short);

  const home = fixture?.teams?.home;
  const away = fixture?.teams?.away;
  const goals = fixture?.goals ?? liveData?.goals;
  const kickoff = fixture?.fixture?.date;
  const timeStr = kickoff ? fmtTimeInTz(kickoff, userTz) : '–';

  const combinada = analysis?.combinada;
  const probability = analysis?.probabilities;

  const liveInfo = liveData || null;
  const events = liveInfo?.events || [];

  if (isHidden) return null;

  return (
    <div
      className={`match-card${isLive ? ' is-live' : ''}${isFavorite ? ' is-favorite' : ''}`}
      style={{ animationDelay: style?.animationDelay }}
    >
      {/* Header row */}
      <div className="match-header">
        {/* Favorite star */}
        <FavoriteStar fixtureId={fid} isFavorite={isFavorite} onToggle={onToggleFavorite} />

        {/* Teams */}
        <div className="match-teams">
          <TeamRow team={home} score={goals?.home} isWinner={isFinished && goals?.home > goals?.away} />
          <TeamRow team={away} score={goals?.away} isWinner={isFinished && goals?.away > goals?.home} />
        </div>

        {/* Score + status */}
        <div className="match-score-area">
          {(isLive || isFinished) && goals ? (
            <div className="match-score">
              {goals.home ?? 0} – {goals.away ?? 0}
            </div>
          ) : null}
          <div className="match-time">
            {isLive || isFinished ? (
              <MatchStatusBadge status={status} elapsed={liveInfo?.elapsed ?? status?.elapsed} />
            ) : (
              <span style={{ color: 'var(--accent-cyan)', fontFamily: 'JetBrains Mono, monospace', fontSize: '.82rem', fontWeight: 600 }}>
                {timeStr}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Live stats */}
      {isLive && <LiveStats liveData={liveInfo} />}

      {/* Goal scorers for finished */}
      {isFinished && events.length > 0 && <GoalScorers events={events} />}

      {/* Footer actions */}
      <div className="match-footer" style={{ flexWrap: 'wrap' }}>
        {/* Probability chip */}
        {probability?.homeWin != null && (
          <div style={{ display: 'flex', gap: 4, fontSize: '.75rem', color: 'var(--text-muted)' }}>
            <span style={{ color: 'var(--accent-green)', fontWeight: 700 }}>{probability.homeWin?.toFixed(0)}%</span>
            <span>|</span>
            <span>{probability.draw?.toFixed(0)}%</span>
            <span>|</span>
            <span style={{ color: 'var(--accent-red)', fontWeight: 700 }}>{probability.awayWin?.toFixed(0)}%</span>
          </div>
        )}

        {/* Combinada chip */}
        {isAnalyzed && combinada && <CombinadaChip combinada={combinada} />}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Actions */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {isAnalyzed && (
            <Link
              href={`/dashboard/analisis/${fid}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '4px 10px', borderRadius: 6, fontSize: '.75rem', fontWeight: 600,
                background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.2)',
                color: 'var(--accent-cyan)', textDecoration: 'none',
                transition: 'all .2s',
              }}
            >
              Ver análisis
            </Link>
          )}
          <button
            onClick={() => onHide && onHide(fid, fixture?.fixture?.date?.split('T')[0])}
            style={{
              width: 26, height: 26, borderRadius: 6, border: '1px solid var(--border-subtle)',
              background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px',
              transition: 'all .2s',
            }}
            title="Ocultar partido"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
