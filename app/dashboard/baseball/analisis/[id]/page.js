'use client';

import { useEffect, useState, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import Image from 'next/image';

const cap = (v) => Math.min(95, Math.max(0, v ?? 0));

export default function BaseballAnalysisPage() {
  const params = useParams();
  const router = useRouter();
  const fid = params.id;

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
    return <div style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>Cargando análisis...</div>;
  }

  if (error && !data) {
    return (
      <div style={{ maxWidth: 800, margin: '0 auto', padding: 24 }}>
        <button onClick={() => router.back()} style={backBtn}>← Volver</button>
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
  const ml = probs?.moneyline;
  const totals = probs?.totals;
  const runLine = probs?.runLine;
  const f5 = probs?.f5;
  const teamTotals = probs?.teamTotals;
  const btts = probs?.btts;
  const expected = probs?.expected;
  const combinada = a?.combinada;
  const dq = a?.data_quality;
  const bestOdds = a?.best_odds;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 16px 60px', color: '#e2e8f0' }}>
      <button onClick={() => router.back()} style={backBtn}>← Volver</button>

      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        style={{
          background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.18)',
          borderRadius: 14, padding: 18, marginTop: 16, marginBottom: 16,
        }}
      >
        <div style={{ fontSize: '.75rem', color: '#94a3b8', fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>
          ⚾ {a?.country} · {a?.league_name}
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
            {dq.hasOdds && <Badge label="Odds" color="#22d3ee" />}
            {dq.hasH2H && <Badge label="H2H" color="#8b5cf6" />}
            {dq.hasHomeStats && dq.hasAwayStats && <Badge label="Stats" color="#10b981" />}
            {dq.hasPitcherMatchup && <Badge label="Pitcher" color="#f59e0b" />}
            {dq.hasPlayerHighlights && <Badge label="Players" color="#a78bfa" />}
          </div>
        )}
      </motion.div>

      {/* Player markets — bloque F. Si players==null, sección oculta. */}
      {probs?.players && <PlayerMarketsSection players={probs.players} />}

      {/* Combinada highlight */}
      {combinada && combinada.combinedProbability >= 60 && (
        <Section title="🎯 Combinada del partido" accent="#f59e0b">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {combinada.selections.map((s, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 12px', borderRadius: 8,
                background: 'rgba(245,158,11,0.06)',
              }}>
                <span style={{ fontWeight: 700, fontSize: '.9rem', flex: 1 }}>{s.market}: {s.pick}</span>
                <span style={{ color: '#10b981', fontWeight: 700 }}>{s.probability}%</span>
                {s.odd && <span style={{ color: '#22d3ee', fontFamily: 'JetBrains Mono, monospace' }}>@{s.odd}</span>}
              </div>
            ))}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 14px', marginTop: 6, borderRadius: 10,
              background: 'rgba(245,158,11,0.12)',
              border: '1px solid rgba(245,158,11,0.3)',
            }}>
              <span style={{ fontWeight: 800, color: '#f59e0b' }}>Probabilidad combinada</span>
              <div style={{ display: 'flex', gap: 12 }}>
                <span style={{ fontSize: '1.3rem', fontWeight: 800, color: '#f59e0b' }}>{combinada.combinedProbability}%</span>
                {combinada.combinedOdd && <span style={{ fontSize: '1.3rem', fontWeight: 800, color: '#22d3ee', fontFamily: 'JetBrains Mono, monospace' }}>@{combinada.combinedOdd}</span>}
              </div>
            </div>
          </div>
        </Section>
      )}

      {/* Moneyline */}
      {ml && (
        <Section title="Moneyline (Ganador)">
          <ProbBar leftLabel={a.home_team} leftPct={cap(ml.home)} rightLabel={a.away_team} rightPct={cap(ml.away)}
            leftOdd={bestOdds?.moneyline?.home} rightOdd={bestOdds?.moneyline?.away} />
        </Section>
      )}

      {/* Totals */}
      {totals?.lines && (
        <Section title="Total de carreras (Over / Under)">
          <div style={{ display: 'grid', gap: 8 }}>
            {Object.entries(totals.lines).map(([line, val]) => {
              const isBest = Number(line) === totals.bestLine;
              return (
                <div key={line} style={{
                  display: 'grid', gridTemplateColumns: '60px 1fr', gap: 10, alignItems: 'center',
                  padding: '8px 10px', borderRadius: 8,
                  background: isBest ? 'rgba(245,158,11,0.08)' : 'rgba(255,255,255,0.03)',
                  border: isBest ? '1px solid rgba(245,158,11,0.3)' : '1px solid rgba(255,255,255,0.05)',
                }}>
                  <div style={{ fontWeight: 700, color: isBest ? '#f59e0b' : '#cbd5e1' }}>O/U {line}</div>
                  <ProbBar leftLabel={`Over`} leftPct={val.over} rightLabel={`Under`} rightPct={val.under}
                    leftOdd={bestOdds?.totals?.[line]?.over?.odd} rightOdd={bestOdds?.totals?.[line]?.under?.odd} compact />
                </div>
              );
            })}
          </div>
          {expected && (
            <div style={{ marginTop: 10, fontSize: '.78rem', color: '#94a3b8' }}>
              Carreras esperadas: <strong style={{ color: '#f59e0b' }}>{expected.lambdaHome} – {expected.lambdaAway}</strong> (total {expected.totalRuns})
            </div>
          )}
        </Section>
      )}

      {/* Run Line */}
      {runLine && (
        <Section title="Run Line ±1.5">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <RunLineRow label={`${a.home_team} -1.5`} pct={runLine.home_minus_1_5} />
            <RunLineRow label={`${a.away_team} +1.5`} pct={runLine.away_plus_1_5} />
            <RunLineRow label={`${a.away_team} -1.5`} pct={runLine.away_minus_1_5} />
            <RunLineRow label={`${a.home_team} +1.5`} pct={runLine.home_plus_1_5} />
          </div>
        </Section>
      )}

      {/* F5 */}
      {f5 && (
        <Section title="First 5 Innings (F5)">
          {f5.moneyline && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: '.8rem', color: '#94a3b8', marginBottom: 6, fontWeight: 700 }}>Ganador F5</div>
              <ProbBar leftLabel={a.home_team} leftPct={cap(f5.moneyline.home)} rightLabel={a.away_team} rightPct={cap(f5.moneyline.away)} compact />
              {f5.moneyline.tie != null && (
                <div style={{ marginTop: 4, fontSize: '.75rem', color: '#94a3b8' }}>
                  Empate F5: <strong>{f5.moneyline.tie}%</strong>
                </div>
              )}
            </div>
          )}
          {f5.totals && (
            <div>
              <div style={{ fontSize: '.8rem', color: '#94a3b8', marginBottom: 6, fontWeight: 700 }}>Total F5</div>
              <div style={{ display: 'grid', gap: 6 }}>
                {Object.entries(f5.totals).map(([line, val]) => (
                  <ProbBar key={line} leftLabel={`O ${line}`} leftPct={val.over} rightLabel={`U ${line}`} rightPct={val.under} compact />
                ))}
              </div>
            </div>
          )}
        </Section>
      )}

      {/* Team Totals */}
      {teamTotals && (
        <Section title="Total por equipo">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div>
              <div style={{ fontSize: '.85rem', fontWeight: 700, marginBottom: 6 }}>{a.home_team}</div>
              {Object.entries(teamTotals.home).map(([line, val]) => (
                <ProbBar key={line} leftLabel={`O ${line}`} leftPct={val.over} rightLabel={`U ${line}`} rightPct={val.under} compact />
              ))}
            </div>
            <div>
              <div style={{ fontSize: '.85rem', fontWeight: 700, marginBottom: 6 }}>{a.away_team}</div>
              {Object.entries(teamTotals.away).map(([line, val]) => (
                <ProbBar key={line} leftLabel={`O ${line}`} leftPct={val.over} rightLabel={`U ${line}`} rightPct={val.under} compact />
              ))}
            </div>
          </div>
        </Section>
      )}

      {/* BTTS */}
      {btts && (
        <Section title="Ambos equipos anotan 1+ carrera">
          <ProbBar leftLabel="Sí" leftPct={btts.yes} rightLabel="No" rightPct={btts.no} />
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
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: '#f59e0b' }}>
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

// =====================================================================
// SUB COMPONENTS
// =====================================================================
function Section({ title, children, accent }) {
  return (
    <motion.section
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
        color: accent || '#f59e0b', letterSpacing: '.3px',
      }}>{title}</h2>
      {children}
    </motion.section>
  );
}

function ProbBar({ leftLabel, leftPct, rightLabel, rightPct, leftOdd, rightOdd, compact = false }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 3 : 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: compact ? '.78rem' : '.88rem' }}>
        <span style={{ fontWeight: 600 }}>
          {leftLabel}
          {leftOdd && <span style={{ marginLeft: 6, color: '#22d3ee', fontFamily: 'JetBrains Mono, monospace', fontSize: '.78em' }}>@{leftOdd}</span>}
        </span>
        <span style={{ fontWeight: 600, textAlign: 'right' }}>
          {rightOdd && <span style={{ marginRight: 6, color: '#22d3ee', fontFamily: 'JetBrains Mono, monospace', fontSize: '.78em' }}>@{rightOdd}</span>}
          {rightLabel}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <span style={{ color: '#10b981', fontWeight: 800, minWidth: 40, fontSize: compact ? '.78rem' : '.88rem' }}>{leftPct}%</span>
        <div style={{ flex: 1, height: compact ? 6 : 10, borderRadius: 4, overflow: 'hidden', display: 'flex', background: 'rgba(255,255,255,0.04)' }}>
          <div style={{ width: `${leftPct}%`, background: 'linear-gradient(90deg,#10b981,#059669)' }} />
          <div style={{ width: `${rightPct}%`, background: 'linear-gradient(90deg,#ef4444,#dc2626)' }} />
        </div>
        <span style={{ color: '#ef4444', fontWeight: 800, minWidth: 40, textAlign: 'right', fontSize: compact ? '.78rem' : '.88rem' }}>{rightPct}%</span>
      </div>
    </div>
  );
}

function RunLineRow({ label, pct }) {
  return (
    <div style={{
      padding: '10px 12px', borderRadius: 8,
      background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <span style={{ flex: 1, fontSize: '.85rem', fontWeight: 600 }}>{label}</span>
      <span style={{ fontWeight: 800, color: pct >= 60 ? '#10b981' : pct <= 40 ? '#ef4444' : '#cbd5e1' }}>{pct}%</span>
    </div>
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
        <div style={{ fontSize: '2rem', fontWeight: 800, color: '#f59e0b', fontFamily: 'JetBrains Mono, monospace' }}>{score}</div>
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

// ── Player markets section — bloque F ──
// Se renderiza solo si probs.players != null (cuando se conecte MLB Stats API).
function PlayerMarketsSection({ players }) {
  const groups = [
    { key: 'strikeouts', title: '🎯 Ponches por pitcher',     emoji: 'K', color: '#a78bfa', unit: 'K' },
    { key: 'hits',       title: '💥 Hits por bateador',        emoji: 'H', color: '#f59e0b', unit: 'hits' },
    { key: 'totalBases', title: '🏃 Bases totales',            emoji: 'TB', color: '#22d3ee', unit: 'bases' },
    { key: 'rbis',       title: '⚾ Carreras impulsadas (RBI)', emoji: 'R', color: '#10b981', unit: 'RBI' },
    { key: 'homeRuns',   title: '🚀 Home runs',                emoji: 'HR', color: '#ef4444', unit: 'HR' },
  ].filter(g => Array.isArray(players[g.key]) && players[g.key].length > 0);

  if (groups.length === 0) return null;

  return (
    <Section title="🌟 Mercados de jugador" accent="#a78bfa">
      {groups.map(g => (
        <div key={g.key} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: '.85rem', color: g.color, fontWeight: 700, marginBottom: 8 }}>{g.title}</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {players[g.key].slice(0, 6).map((pl, i) => (
              <div key={pl.id || i} style={{
                padding: '10px 12px', borderRadius: 8,
                background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: '.9rem', flex: 1 }}>{pl.name}</span>
                  <span style={{ fontSize: '.7rem', color: '#94a3b8' }}>{pl.teamName}</span>
                  <span style={{
                    fontSize: '.75rem', color: g.color, fontFamily: 'JetBrains Mono, monospace', fontWeight: 700,
                  }}>{pl.total ?? 0} {g.unit} hist.</span>
                </div>
                {pl.lineProbs && Object.keys(pl.lineProbs).length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {Object.entries(pl.lineProbs).map(([line, prob]) => (
                      <span key={line} style={{
                        padding: '3px 8px', borderRadius: 6, fontSize: '.72rem', fontWeight: 700,
                        background: prob >= 70 ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.1)',
                        border: `1px solid ${prob >= 70 ? '#10b981' : 'rgba(245,158,11,0.25)'}`,
                        color: prob >= 70 ? '#10b981' : '#f59e0b',
                      }}>
                        Más de {line}: {prob}%
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </Section>
  );
}

const navBtnPlain = {
  padding: '6px 12px', borderRadius: 8,
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
  color: '#cbd5e1', cursor: 'pointer', fontSize: '.85rem', fontWeight: 600,
};
const backBtn = { ...navBtnPlain };
const primaryBtn = { ...navBtnPlain, background: 'rgba(245,158,11,0.15)', border: '1px solid #f59e0b', color: '#f59e0b' };
const secondaryBtn = { ...navBtnPlain, background: 'rgba(34,211,238,0.1)', border: '1px solid rgba(34,211,238,0.3)', color: '#22d3ee' };
