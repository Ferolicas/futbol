'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import Image from 'next/image';
import DashboardBuffer from '../../../components/DashboardBuffer';
import BaseballResultStats from '../../components/BaseballResultStats';
import { displayBettingText } from '../../../utils/display-betting-text';
import { BASEBALL_RECOMMENDATION_MIN_PROBABILITY } from '../../../../../lib/recommendation-policy';
import FinalVerdictPanel from '../../../components/FinalVerdictPanel';

const cap = (v) => {
  const value = Math.max(0, Math.min(100, Number(v) || 0));
  if (value >= 95) return 95;
  return Math.floor((value + 1e-9) * 100) / 100;
};
const isBet365Market = (market) => String(market?.bookmaker || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '') === 'bet365'
  && Number(market?.odd) >= 1.20
  && Number(market?.rawProbability ?? market?.probability) >= BASEBALL_RECOMMENDATION_MIN_PROBABILITY;

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
          <TeamHeader name={a?.home_team} score={result?.home_score} side="LOCAL" probability={probs?.moneyline?.home} />
          <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#64748b' }}>VS</div>
          <TeamHeader name={a?.away_team} score={result?.away_score} side="VISITANTE" probability={probs?.moneyline?.away} />
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

      {result?.home_score != null && result?.away_score != null && (
        <Section title={result.status === 'FT' ? 'Resultado oficial MLB' : 'Estadísticas en vivo MLB'} accent="#22d3ee">
          <BaseballResultStats
            result={result}
            homeName={a?.home_team || 'Local'}
            awayName={a?.away_team || 'Visitante'}
          />
        </Section>
      )}

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
            No se publica ninguna recomendación: Bet365 no ofrece ahora una línea compatible con probabilidad mínima del {BASEBALL_RECOMMENDATION_MIN_PROBABILITY}% y cuota mínima de 1,20.
          </div>
        )}
      </Section>

      {probs && (
        <CompleteBaseballAnalysis
          probabilities={probs}
          homeName={a?.home_team || 'Local'}
          awayName={a?.away_team || 'Visitante'}
        />
      )}

      <FinalVerdictPanel
        verdict={a?.analysis?.finalVerdict}
        homeName={a?.home_team || 'Local'}
        awayName={a?.away_team || 'Visitante'}
      />

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

const PLAYER_CATEGORY_LABELS = Object.freeze({
  hits: 'Hits',
  homeRuns: 'Jonrones',
  totalBases: 'Bases totales',
  rbis: 'Carreras impulsadas',
  runs: 'Carreras anotadas',
  walks: 'Bases por bolas',
  stolenBases: 'Bases robadas',
  strikeouts: 'Ponches del lanzador',
  battingStrikeouts: 'Ponches del bateador',
});

function probabilityText(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `${cap(value)}%`;
}

function ProbabilityPill({ label, value, tone = '#5ee6b1', probability = true }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      padding: '5px 8px', borderRadius: 8, background: 'rgba(255,255,255,.035)',
      border: '1px solid rgba(255,255,255,.07)', minWidth: 0,
    }}>
      <small style={{ color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</small>
      <strong style={{ color: tone, fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
        {probability ? probabilityText(value) : (value == null ? '—' : value)}
      </strong>
    </span>
  );
}

function ProbabilityLadder({ title, lines }) {
  const entries = Object.entries(lines || {}).sort((left, right) => Number(left[0]) - Number(right[0]));
  if (!entries.length) return null;
  return (
    <div style={{ minWidth: 0 }}>
      {title && <h3 style={{ margin: '0 0 7px', color: '#cbd5e1', fontSize: '.78rem' }}>{title}</h3>}
      <div style={{ display: 'grid', gap: 5 }}>
        {entries.map(([line, values]) => {
          const n = values?.evidence?.over?.n ?? values?.evidence?.under?.n;
          return (
            <div key={line} style={{
              display: 'grid', gridTemplateColumns: 'minmax(52px,.55fr) 1fr 1fr', gap: 5,
              alignItems: 'center', padding: '5px 7px', borderRadius: 8,
              background: 'rgba(255,255,255,.025)', border: '1px solid rgba(255,255,255,.05)',
            }}>
              <span style={{ color: '#e2e8f0', fontSize: '.72rem', fontWeight: 800 }}>
                Línea {line}{n ? <small style={{ display: 'block', color: '#64748b', fontWeight: 500 }}>n={n}</small> : null}
              </span>
              <ProbabilityPill label="Más" value={values?.over} />
              <ProbabilityPill label="Menos" value={values?.under} tone="#fcd34d" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RunLines({ runLines, homeName, awayName }) {
  const rows = [
    ...Object.entries(runLines?.home || {}).map(([line, value]) => ({ key: `h-${line}`, name: homeName, line, value })),
    ...Object.entries(runLines?.away || {}).map(([line, value]) => ({ key: `a-${line}`, name: awayName, line, value })),
  ].sort((left, right) => Number(right.value) - Number(left.value));
  if (!rows.length) return null;
  return (
    <div>
      <h3 style={{ margin: '0 0 7px', color: '#cbd5e1', fontSize: '.78rem' }}>Hándicaps de carreras calculados</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 5 }}>
        {rows.map((row) => <ProbabilityPill key={row.key} label={`${row.name} ${Number(row.line) > 0 ? '+' : ''}${row.line}`} value={row.value} />)}
      </div>
    </div>
  );
}

function PeriodAnalysis({ periods, homeName, awayName }) {
  const rows = Object.entries(periods || {}).filter(([key]) => !/^inning\d+$/.test(key));
  if (!rows.length) return null;
  return (
    <Section title="Tramos acumulados del partido">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(250px,1fr))', gap: 10 }}>
        {rows.map(([key, period]) => (
          <article key={key} style={{ padding: 11, borderRadius: 10, background: 'rgba(94,230,177,.035)', border: '1px solid rgba(94,230,177,.12)' }}>
            <h3 style={{ margin: '0 0 8px', color: '#5ee6b1', fontSize: '.82rem', textTransform: 'capitalize' }}>{period.label || key}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 5, marginBottom: 8 }}>
              <ProbabilityPill label={homeName} value={period.moneyline?.home} />
              <ProbabilityPill label="Empate" value={period.moneyline?.tie} tone="#fcd34d" />
              <ProbabilityPill label={awayName} value={period.moneyline?.away} />
            </div>
            <ProbabilityLadder title="Carreras totales" lines={period.totals} />
          </article>
        ))}
      </div>
    </Section>
  );
}

function InningsAnalysis({ innings, homeName, awayName }) {
  const rows = Object.entries(innings || {}).sort((left, right) => Number(left[0]) - Number(right[0]));
  if (!rows.length) return null;
  return (
    <Section title="Análisis entrada por entrada">
      <p style={{ margin: '0 0 12px', color: '#94a3b8', fontSize: '.78rem', lineHeight: 1.55 }}>
        Las nueve entradas se calculan con el historial real disponible. Se muestran aunque Bet365 no tenga una cuota para esa entrada.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(235px,1fr))', gap: 8 }}>
        {rows.map(([inning, values]) => (
          <article key={inning} style={{ padding: 10, borderRadius: 10, background: 'rgba(255,255,255,.025)', border: '1px solid rgba(255,255,255,.07)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', marginBottom: 7 }}>
              <strong style={{ color: '#5ee6b1', fontSize: '.82rem' }}>{inning}.ª entrada</strong>
              <small style={{ color: '#64748b' }}>media {values.expected?.total == null ? '—' : Number(values.expected.total).toFixed(2)}</small>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, marginBottom: 7 }}>
              <ProbabilityPill label="Habrá carrera" value={values.run?.yes} />
              <ProbabilityPill label="Sin carrera" value={values.run?.no} tone="#fcd34d" />
              <ProbabilityPill label={`${homeName} anota`} value={values.teamTotals?.home?.['0.5']?.over} />
              <ProbabilityPill label={`${awayName} anota`} value={values.teamTotals?.away?.['0.5']?.over} />
            </div>
            <ProbabilityLadder lines={values.totals} />
          </article>
        ))}
      </div>
    </Section>
  );
}

function TeamStatistics({ statistics, homeName, awayName }) {
  const rows = Object.entries(statistics || {});
  if (!rows.length) return null;
  return (
    <Section title="Estadísticas de equipos">
      <div style={{ display: 'grid', gap: 14 }}>
        {rows.map(([key, values]) => (
          <div key={key}>
            <h3 style={{ margin: '0 0 8px', color: '#5ee6b1', fontSize: '.84rem', textTransform: 'capitalize' }}>{values.label || key}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: 8 }}>
              <ProbabilityLadder title={homeName} lines={values.home} />
              <ProbabilityLadder title={awayName} lines={values.away} />
              <ProbabilityLadder title="Total del partido" lines={values.total} />
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function SpecialAnalysis({ specials, homeName, awayName }) {
  if (!specials || !Object.keys(specials).length) return null;
  const primary = [
    ['Total de carreras impar', specials.totalParity?.odd],
    ['Total de carreras par', specials.totalParity?.even],
    [`${homeName} anota primero`, specials.firstTeamScore?.home],
    [`${awayName} anota primero`, specials.firstTeamScore?.away],
    [`${homeName} anota de último`, specials.lastTeamScore?.home],
    [`${awayName} anota de último`, specials.lastTeamScore?.away],
    ['Habrá entradas extra', specials.extraInnings?.yes],
    ['No habrá entradas extra', specials.extraInnings?.no],
    [`${homeName}: carreras impares`, specials.teamParity?.home?.odd],
    [`${homeName}: carreras pares`, specials.teamParity?.home?.even],
    [`${awayName}: carreras impares`, specials.teamParity?.away?.odd],
    [`${awayName}: carreras pares`, specials.teamParity?.away?.even],
    [`${homeName} termina con más carreras`, specials.highestScoring?.home],
    [`${awayName} termina con más carreras`, specials.highestScoring?.away],
  ].filter(([, value]) => value != null);
  const detailed = [
    ...Object.entries(specials.correctScore || {}).map(([key, value]) => [`Marcador exacto ${key}`, value]),
    ...Object.entries(specials.halfFull || {}).map(([key, value]) => [`Primeras 5 / final: ${displayBettingText(key)}`, value]),
    ...Object.entries(specials.resultTotals || {}).map(([key, value]) => [`Resultado y carreras: ${displayBettingText(key)}`, value]),
  ].filter(([, value]) => value != null);
  if (!primary.length && !detailed.length) return null;
  return (
    <Section title="Situaciones especiales">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 6 }}>
        {primary.map(([label, value]) => <ProbabilityPill key={label} label={label} value={value} />)}
      </div>
      {detailed.length > 0 && (
        <details style={{ marginTop: 10, border: '1px solid rgba(255,255,255,.07)', borderRadius: 9 }}>
          <summary style={{ padding: '9px 10px', cursor: 'pointer', color: '#cbd5e1', fontSize: '.78rem', fontWeight: 800 }}>
            Marcadores y combinaciones calculadas · {detailed.length}
          </summary>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 6, padding: 8 }}>
            {detailed.map(([label, value]) => <ProbabilityPill key={label} label={label} value={value} />)}
          </div>
        </details>
      )}
    </Section>
  );
}

function PitcherAnalysis({ pitchers }) {
  if (!pitchers?.home && !pitchers?.away) return null;
  return (
    <Section title="Lanzadores abridores">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 8 }}>
        {['home', 'away'].map((side) => {
          const pitcher = pitchers?.[side];
          if (!pitcher) return null;
          return (
            <article key={side} style={{ padding: 11, borderRadius: 10, background: 'rgba(255,255,255,.025)', border: '1px solid rgba(255,255,255,.07)' }}>
              <strong style={{ color: '#e2e8f0' }}>{pitcher.name || 'Abridor por confirmar'}</strong>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(78px,1fr))', gap: 5, marginTop: 9 }}>
                <ProbabilityPill label="ERA" value={pitcher.stats?.era == null ? null : Number(pitcher.stats.era).toFixed(2)} probability={false} />
                <ProbabilityPill label="WHIP" value={pitcher.stats?.whip == null ? null : Number(pitcher.stats.whip).toFixed(2)} probability={false} />
                <ProbabilityPill label="K/9" value={pitcher.stats?.k9 == null ? null : Number(pitcher.stats.k9).toFixed(2)} probability={false} />
                <ProbabilityPill label="IP" value={pitcher.stats?.ip == null ? null : Number(pitcher.stats.ip).toFixed(1)} probability={false} />
              </div>
            </article>
          );
        })}
      </div>
    </Section>
  );
}

function PlayerAnalysis({ players }) {
  const rows = Object.entries(players || {}).filter(([, entries]) => Array.isArray(entries) && entries.length);
  if (!rows.length) return null;
  return (
    <Section title="Bateadores y lanzadores — análisis completo">
      <p style={{ margin: '0 0 12px', color: '#94a3b8', fontSize: '.78rem', lineHeight: 1.55 }}>
        Cada porcentaje sale del registro partido a partido del jugador. Este bloque no depende de que exista una cuota.
      </p>
      <div style={{ display: 'grid', gap: 7 }}>
        {rows.map(([category, entries], categoryIndex) => (
          <details key={category} open={categoryIndex < 2} style={{ border: '1px solid rgba(94,230,177,.12)', borderRadius: 10, overflow: 'hidden' }}>
            <summary style={{ padding: '10px 12px', cursor: 'pointer', color: '#5ee6b1', fontSize: '.82rem', fontWeight: 800, background: 'rgba(94,230,177,.035)' }}>
              {PLAYER_CATEGORY_LABELS[category] || category} · {entries.length} jugadores
            </summary>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(250px,1fr))', gap: 7, padding: 8 }}>
              {entries.map((player) => (
                <article key={`${category}-${player.id || player.name}`} style={{ padding: 9, borderRadius: 9, background: 'rgba(255,255,255,.025)', border: '1px solid rgba(255,255,255,.06)', minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    {player.photo && <Image src={player.photo} alt={player.name || 'Jugador'} width={34} height={34} style={{ borderRadius: '50%', objectFit: 'cover', background: 'rgba(255,255,255,.05)' }} unoptimized />}
                    <span style={{ minWidth: 0 }}>
                      <strong style={{ display: 'block', color: '#e2e8f0', fontSize: '.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{player.name}</strong>
                      <small style={{ color: '#64748b' }}>{player.teamName || 'MLB'} · media {player.mean} · {player.history?.length || 0} partidos</small>
                    </span>
                  </div>
                  <div style={{ display: 'grid', gap: 5 }}>
                    {Object.entries(player.lineSides || {}).sort((left, right) => Number(left[0]) - Number(right[0])).map(([line, sides]) => (
                      <div key={line} style={{ display: 'grid', gridTemplateColumns: '50px 1fr 1fr', gap: 5, alignItems: 'center' }}>
                        <small style={{ color: '#94a3b8', fontWeight: 700 }}>Línea {line}</small>
                        <ProbabilityPill label="Más" value={sides.over?.probability} />
                        <ProbabilityPill label="Menos" value={sides.under?.probability} tone="#fcd34d" />
                      </div>
                    ))}
                  </div>
                  {player.history?.length > 0 && (
                    <small style={{ display: 'block', color: '#64748b', marginTop: 7, lineHeight: 1.4 }}>
                      Últimos registros: {player.history.slice(-10).reverse().join(' · ')}
                    </small>
                  )}
                </article>
              ))}
            </div>
          </details>
        ))}
      </div>
    </Section>
  );
}

function CompleteBaseballAnalysis({ probabilities, homeName, awayName }) {
  const expected = probabilities.expected;
  return (
    <>
      <Section title="Análisis estadístico completo">
        <p style={{ margin: '0 0 12px', color: '#94a3b8', fontSize: '.78rem', lineHeight: 1.55 }}>
          Aquí aparece todo lo calculado con los antecedentes reales; las cuotas solo determinan qué opciones pasan a la sección apostable.
        </p>
        {expected && (
          <div style={{ color: '#94a3b8', fontSize: '.82rem', lineHeight: 1.6, marginBottom: 12 }}>
            Media ponderada: <strong style={{ color: '#5ee6b1' }}>{expected.lambdaHome} carreras de {homeName} y {expected.lambdaAway} de {awayName}</strong>; total medio {expected.totalRuns}.
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(245px,1fr))', gap: 12 }}>
          <div>
            <h3 style={{ margin: '0 0 7px', color: '#cbd5e1', fontSize: '.78rem' }}>Ganador</h3>
            <div style={{ display: 'grid', gap: 5 }}>
              <ProbabilityPill label={homeName} value={probabilities.moneyline?.home} />
              <ProbabilityPill label={awayName} value={probabilities.moneyline?.away} />
            </div>
          </div>
          <ProbabilityLadder title="Carreras totales" lines={probabilities.totals?.lines} />
          <ProbabilityLadder title={`Carreras de ${homeName}`} lines={probabilities.teamTotals?.home} />
          <ProbabilityLadder title={`Carreras de ${awayName}`} lines={probabilities.teamTotals?.away} />
        </div>
        <div style={{ marginTop: 12 }}><RunLines runLines={probabilities.runLines} homeName={homeName} awayName={awayName} /></div>
      </Section>
      <PeriodAnalysis periods={probabilities.periods} homeName={homeName} awayName={awayName} />
      <InningsAnalysis innings={probabilities.innings} homeName={homeName} awayName={awayName} />
      <TeamStatistics statistics={probabilities.statistics} homeName={homeName} awayName={awayName} />
      <SpecialAnalysis specials={probabilities.specials} homeName={homeName} awayName={awayName} />
      <PitcherAnalysis pitchers={probabilities.pitchers} />
      <PlayerAnalysis players={probabilities.players} />
    </>
  );
}

function TeamHeader({ name, score, side, probability }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: '.7rem', color: '#64748b', fontWeight: 700, letterSpacing: 1 }}>{side}</div>
        <div style={{ fontSize: '1.15rem', fontWeight: 800 }}>{name}</div>
        {probability != null && (
          <div style={{ marginTop: 3, color: '#5ee6b1', fontSize: '.72rem', fontWeight: 800 }}>
            Probabilidad de ganar: {cap(probability)}%
          </div>
        )}
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
