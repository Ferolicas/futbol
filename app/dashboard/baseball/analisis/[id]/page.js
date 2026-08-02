'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import Image from 'next/image';
import DashboardBuffer from '../../../components/DashboardBuffer';
import { displayBettingText } from '../../../utils/display-betting-text';

const cap = (v) => {
  const value = Math.max(0, Math.min(100, Number(v) || 0));
  if (value >= 95) return 95;
  return Math.floor((value + 1e-9) * 100) / 100;
};
const isBet365Market = (market) => String(market?.bookmaker || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '') === 'bet365'
  && Number(market?.odd) >= 1.20
  && Number(market?.rawProbability ?? market?.probability) >= 80;

export function BaseballAnalysisExperience({ fixtureId, embedded = false, onClose }) {
  const params = useParams();
  const router = useRouter();
  const fid = fixtureId || params.id;
  const closeOrBack = () => {
    if (embedded && onClose) onClose();
    else router.back();
  };

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [analyzing, setAnalyzing] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/baseball/match/${fid}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed');
      setData(json);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (fid) fetchData(); }, [fid]);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    try {
      const res = await fetch(`/api/baseball/match/${fid}/analyze`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Analysis failed');
      await fetchData();
    } catch (e) {
      setError(e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  if (loading) {
    return <DashboardBuffer compact={embedded} />;
  }

  if (error && !data) {
    return (
      <div style={{ maxWidth: 800, margin: '0 auto', padding: 24 }}>
        <button onClick={closeOrBack} style={backBtn}>← Volver</button>
        <div style={{
          marginTop: 24, padding: 16, borderRadius: 10,
          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
          color: '#fca5a5',
        }}>
          {error}
        </div>
        <button onClick={handleAnalyze} disabled={analyzing} style={{ ...primaryBtn, marginTop: 16 }}>
          {analyzing ? 'Analizando...' : 'Generar análisis ahora'}
        </button>
      </div>
    );
  }

  const a = data?.analysis;
  const result = data?.result;
  const probs = a?.probabilities;
  const expected = probs?.expected;
  const combinada = a?.combinada;
  const dq = a?.data_quality;
  const markets = (Array.isArray(combinada?.selectable) ? combinada.selectable : [])
    .filter(isBet365Market)
    .sort((left, right) => Number(right.rawProbability ?? right.probability) - Number(left.rawProbability ?? left.probability)
      || Number(right.odd) - Number(left.odd));
  const highlighted = (Array.isArray(combinada?.selections) ? combinada.selections : []).filter(isBet365Market);

  return (
    <div className={`baseball-analysis-page ${embedded ? 'is-embedded' : ''}`} style={{ maxWidth: 1100, margin: '0 auto', padding: '0 16px 60px', color: '#e2e8f0' }}>
      {!embedded && <button onClick={closeOrBack} style={backBtn}>← Volver</button>}

      {/* Header */}
      <motion.div
        className="baseball-analysis-hero"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        style={{
          background: 'rgba(94,230,177,0.05)', border: '1px solid rgba(94,230,177,0.18)',
          borderRadius: 14, padding: 18, marginTop: 16, marginBottom: 16,
        }}
      >
        <div style={{ fontSize: '.75rem', color: '#94a3b8', fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>
          Baseball · {a?.country} · {a?.league_name}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <TeamHeader name={a?.home_team} score={result?.home_score} side="HOME" />
          <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#64748b' }}>VS</div>
          <TeamHeader name={a?.away_team} score={result?.away_score} side="AWAY" />
        </div>
        {a?.start_time && (
          <div style={{ marginTop: 10, fontSize: '.85rem', color: '#64748b', fontFamily: 'JetBrains Mono, monospace' }}>
            {new Date(a.start_time).toLocaleString('es-ES')}
          </div>
        )}
        {dq && (
          <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Badge label={`Calidad: ${dq.score}%`} color={dq.score >= 75 ? '#10b981' : dq.score >= 50 ? '#f59e0b' : '#ef4444'} />
            {dq.hasOdds && <Badge label="Cuotas Bet365" color="#22d3ee" />}
            {dq.hasH2H && <Badge label="H2H" color="#8b5cf6" />}
            {dq.hasHomeStats && dq.hasAwayStats && <Badge label="Stats" color="#10b981" />}
            {dq.hasPitcherMatchup && <Badge label="Pitcher" color="#f59e0b" />}
            {dq.hasPlayerHighlights && <Badge label="Players" color="#a78bfa" />}
          </div>
        )}
      </motion.div>

      {/* Combinada highlight */}
      {highlighted.length > 0 && combinada.combinedProbability >= 60 && (
        <Section title="Combinada Bet365 del partido" accent="#5ee6b1">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {highlighted.map((s, i) => (
              <div key={i} style={{
                display: 'grid', gridTemplateColumns: '1fr auto auto', alignItems: 'center', gap: 10,
                padding: '10px 12px', borderRadius: 8,
                background: 'rgba(94,230,177,0.06)',
              }}>
                <span style={{ minWidth: 0 }}>
                  <small style={{ display: 'block', color: '#94a3b8', marginBottom: 2 }}>{s.marketLabel || s.market}</small>
                  <strong style={{ fontSize: '.9rem', lineHeight: 1.35 }}>{displayBettingText(s.pick || s.name)}</strong>
                </span>
                <span style={{ color: '#10b981', fontWeight: 700 }}>{cap(s.rawProbability ?? s.probability)}%</span>
                <span style={{ color: '#f5e400', fontFamily: 'JetBrains Mono, monospace' }}>@{Number(s.odd).toFixed(2)}</span>
              </div>
            ))}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 14px', marginTop: 6, borderRadius: 10,
              background: 'rgba(94,230,177,0.12)',
              border: '1px solid rgba(94,230,177,0.3)',
            }}>
              <span style={{ fontWeight: 800, color: '#5ee6b1' }}>Probabilidad combinada</span>
              <div style={{ display: 'flex', gap: 12 }}>
                <span style={{ fontSize: '1.3rem', fontWeight: 800, color: '#5ee6b1' }}>{cap(combinada.combinedProbability)}%</span>
                {combinada.combinedOdd && <span style={{ fontSize: '1.3rem', fontWeight: 800, color: '#22d3ee', fontFamily: 'JetBrains Mono, monospace' }}>@{combinada.combinedOdd}</span>}
              </div>
            </div>
          </div>
        </Section>
      )}

      <Section title="Opciones disponibles en Bet365">
        {markets.length > 0 ? (
          <div style={{ display: 'grid', gap: 8 }}>
            {markets.map((market) => (
              <article key={market.id} style={{
                display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center',
                padding: '11px 12px', borderRadius: 9, background: 'rgba(255,255,255,.03)',
                border: '1px solid rgba(94,230,177,.12)',
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3, flexWrap: 'wrap' }}>
                    <span style={{ padding: '2px 6px', borderRadius: 999, background: '#f5e400', color: '#10241e', fontSize: '.58rem', fontWeight: 900 }}>BET365</span>
                    <small style={{ color: '#94a3b8' }}>{market.marketLabel || market.market}</small>
                  </div>
                  <strong style={{ fontSize: '.88rem', lineHeight: 1.35 }}>{displayBettingText(market.name)}</strong>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                  <strong style={{ color: '#5ee6b1' }}>{cap(market.rawProbability ?? market.probability)}%</strong>
                  <strong style={{ color: '#f5e400' }}>@{Number(market.odd).toFixed(2)}</strong>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div style={{ color: '#94a3b8', fontSize: '.84rem', lineHeight: 1.5 }}>
            No se publica ninguna recomendación: Bet365 no ofrece ahora una línea compatible con probabilidad mínima del 80% y cuota mínima de 1,20.
          </div>
        )}
      </Section>

      {expected && (
        <Section title="Resumen estadístico">
          <div style={{ color: '#94a3b8', fontSize: '.82rem', lineHeight: 1.6 }}>
            Media ponderada en antecedentes comparables: <strong style={{ color: '#5ee6b1' }}>{expected.lambdaHome} carreras de {a.home_team} y {expected.lambdaAway} de {a.away_team}</strong>; total medio {expected.totalRuns}.
          </div>
        </Section>
      )}

      {/* H2H */}
      {a?.analysis?.h2h?.length > 0 && (
        <Section title="Últimos enfrentamientos (H2H)">
          <div style={{ display: 'grid', gap: 6 }}>
            {a.analysis.h2h.slice(0, 6).map((h, i) => {
              const hsc = h.scores?.home?.total ?? h.scores?.home;
              const asc = h.scores?.away?.total ?? h.scores?.away;
              return (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '6px 10px', borderRadius: 6,
                  background: 'rgba(255,255,255,0.03)',
                  fontSize: '.85rem',
                }}>
                  <span style={{ flex: 1, color: '#cbd5e1' }}>{h.teams?.home?.name}</span>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: '#5ee6b1' }}>
                    {hsc} – {asc}
                  </span>
                  <span style={{ flex: 1, textAlign: 'right', color: '#cbd5e1' }}>{h.teams?.away?.name}</span>
                  <span style={{ fontSize: '.7rem', color: '#64748b', minWidth: 80, textAlign: 'right' }}>
                    {h.date ? new Date(h.date).toLocaleDateString('es-ES') : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* Re-analizar quitado — el re-analisis manual va por /ferney
          'Analizar baseball' (admin), y el cron diario re-analiza solo
          cuando age>6h o cache_version<MIN. El boton aqui invitaba a
          consumir API gratuita sin necesidad. Refresh sigue para releer
          BD por si el cron actualizo en segundo plano. */}
      <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
        <button onClick={fetchData} style={primaryBtn}>↻ Refrescar</button>
      </div>
    </div>
  );
}

export default function BaseballAnalysisPage() {
  return <BaseballAnalysisExperience />;
}

// =====================================================================
// SUB COMPONENTS
// =====================================================================
function Section({ title, children, accent }) {
  return (
    <motion.section
      className="baseball-analysis-section"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 14, padding: 16, marginBottom: 14,
      }}
    >
      <h2 style={{
        margin: '0 0 12px', fontSize: '.95rem', fontWeight: 800,
        color: accent || '#5ee6b1', letterSpacing: '.3px',
      }}>{title}</h2>
      {children}
    </motion.section>
  );
}

function TeamHeader({ name, score, side }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: '.7rem', color: '#64748b', fontWeight: 700, letterSpacing: 1 }}>{side}</div>
        <div style={{ fontSize: '1.15rem', fontWeight: 800 }}>{name}</div>
      </div>
      {score != null && (
        <div style={{ fontSize: '2rem', fontWeight: 800, color: '#5ee6b1', fontFamily: 'JetBrains Mono, monospace' }}>{score}</div>
      )}
    </div>
  );
}

function Badge({ label, color }) {
  return (
    <span style={{
      padding: '3px 9px', borderRadius: 999, fontSize: '.7rem', fontWeight: 700,
      background: `${color}1a`, border: `1px solid ${color}55`, color,
    }}>{label}</span>
  );
}

const navBtnPlain = {
  padding: '6px 12px', borderRadius: 8,
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
  color: '#cbd5e1', cursor: 'pointer', fontSize: '.85rem', fontWeight: 600,
};
const backBtn = { ...navBtnPlain };
const primaryBtn = { ...navBtnPlain, background: 'rgba(94,230,177,0.15)', border: '1px solid #5ee6b1', color: '#5ee6b1' };
