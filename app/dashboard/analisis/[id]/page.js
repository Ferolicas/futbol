'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronLeft, Zap, AlertTriangle, TrendingUp, Trophy, Star,
  Users, BarChart3, Percent, History, Scale, Target, Crosshair,
  ChevronDown, Clock, Flag, Check,
} from 'lucide-react';
import { computeAllProbabilities } from '../../../../lib/calculations';
import { buildCombinada } from '../../../../lib/combinada';
import { selectBookmakerOdds, BOOKMAKER_LOGOS, TIMEZONE_TO_COUNTRY } from '../../../../lib/bookmakers';
import { getAnalysisCache, setAnalysisCache } from '../../../../lib/analysis-cache';
import { useLiveStats } from '../../live-stats-context';
import { useSelectedMarkets } from '../../selected-markets-context';
import { getUserTz, fmtTimeInTz, todayInTz } from '../../../../lib/timezone';

function detectCountry() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TIMEZONE_TO_COUNTRY[tz] || 'default';
  } catch { return 'default'; }
}

const cap = (v) => Math.min(95, v);
const fmtTime = (d, tz) => fmtTimeInTz(d, tz || getUserTz());
const fmtDate = (d, tz) => new Date(d).toLocaleDateString('es', { timeZone: tz || getUserTz(), weekday: 'long', day: 'numeric', month: 'long' });
const fmtShortDate = (d, tz) => new Date(d).toLocaleDateString('es', { timeZone: tz || getUserTz(), day: '2-digit', month: 'short' });
const statusLabel = (s) => ({
  NS: 'PRÓXIMO', '1H': 'EN VIVO — 1T', '2H': 'EN VIVO — 2T', HT: 'EN VIVO — Entretiempo',
  FT: 'FINALIZADO', ET: 'EN VIVO — Extra', P: 'EN VIVO — Penales',
  AET: 'FINALIZADO', PEN: 'FINALIZADO', SUSP: 'SUSPENDIDO', PST: 'POSPUESTO', CANC: 'CANCELADO',
}[s] || s);
const isLiveStatus = (s) => ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'].includes(s);
const isClockRunning = (s) => ['1H', '2H', 'ET', 'LIVE'].includes(s);

function getProbColor(v) {
  if (v >= 70) return 'hi';
  if (v >= 50) return 'md';
  return 'lo';
}

export default function AnalisisPage() {
  const params = useParams();
  const router = useRouter();
  const fixtureId = params.id;

  // Hydrate from hand-off cache so the page renders instantly when arriving
  // from the dashboard — then revalidate in background via fetch.
  const initialCached = typeof window !== 'undefined' ? getAnalysisCache(fixtureId) : null;
  const initialAnalysis = initialCached?.analysis || null;
  const initialProbs    = initialAnalysis?.calculatedProbabilities
    ? initialAnalysis.calculatedProbabilities
    : (initialAnalysis ? computeAllProbabilities(initialAnalysis) : null);
  const initialCombinada = initialAnalysis
    ? (initialAnalysis.combinada || (initialProbs ? buildCombinada(initialProbs, initialAnalysis.odds, initialAnalysis.playerHighlights, { home: initialAnalysis.homeTeam, away: initialAnalysis.awayTeam }) : null))
    : null;

  const [analysis, setAnalysis] = useState(initialAnalysis);
  const [loading, setLoading] = useState(!initialAnalysis);
  const [error, setError] = useState('');
  const [quota, setQuota] = useState(null);
  const [probabilities, setProbabilities] = useState(initialProbs);
  const [combinada, setCombinada] = useState(initialCombinada);
  const { selectedMarkets, toggleMarket } = useSelectedMarkets();
  const [collapsed, setCollapsed] = useState({});
  const [notAnalyzed, setNotAnalyzed] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [refreshingLineups, setRefreshingLineups] = useState(false);
  const [refreshingInjuries, setRefreshingInjuries] = useState(false);
  const [userCountry, setUserCountry] = useState('default');
  const { liveStats: allLiveStats, setLiveStats, isPopulated } = useLiveStats();
  const liveStats = allLiveStats[fixtureId];
  const [, tickLive] = useState(0);

  useEffect(() => { setUserCountry(detectCountry()); }, []);

  // Tick every second while match is live so the counter updates in real-time
  const liveStatusShort = liveStats?.status?.short;
  useEffect(() => {
    if (!isClockRunning(liveStatusShort)) return;
    const id = setInterval(() => tickLive(n => n + 1), 1000);
    return () => clearInterval(id);
  }, [liveStatusShort]);

  const toggleSection = (key) => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }));

  const doAnalyze = async () => {
    setAnalyzing(true);
    setError('');
    try {
      const localDate = todayInTz(getUserTz());
      const res = await fetch(`/api/match/${fixtureId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'analyze', date: localDate }),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      setNotAnalyzed(false);
      setAnalysis(data.analysis);
      if (data.quota) setQuota(data.quota);
      const probs = data.analysis.calculatedProbabilities || computeAllProbabilities(data.analysis);
      setProbabilities(probs);
      const teamNames = { home: data.analysis.homeTeam, away: data.analysis.awayTeam };
      const combo = data.analysis.combinada || buildCombinada(probs, data.analysis.odds, data.analysis.playerHighlights, teamNames);
      setCombinada(combo);
    } catch (e) {
      setError(e.message || 'Error al analizar');
    } finally {
      setAnalyzing(false);
    }
  };

  const loadAnalysis = useCallback(async ({ silent } = {}) => {
    if (!silent) setLoading(true);
    setError('');
    setNotAnalyzed(false);
    try {
      const localDate = todayInTz(getUserTz());
      const res = await fetch(`/api/match/${fixtureId}?date=${localDate}`);
      const data = await res.json();
      if (data.notFound) { setNotAnalyzed(true); return; }
      if (data.error) { setError(data.error); return; }
      setAnalysis(data.analysis);
      if (data.quota) setQuota(data.quota);
      const probs = data.analysis.calculatedProbabilities || computeAllProbabilities(data.analysis);
      setProbabilities(probs);
      const teamNames = { home: data.analysis.homeTeam, away: data.analysis.awayTeam };
      const combo = data.analysis.combinada || buildCombinada(probs, data.analysis.odds, data.analysis.playerHighlights, teamNames);
      setCombinada(combo);
      // Refresh the hand-off cache so a quick back-and-forth uses the fresher data
      setAnalysisCache(fixtureId, { analysis: data.analysis });
    } catch (e) {
      if (!silent) setError(e.message || 'Error loading analysis');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [fixtureId]);

  // On mount: if we hydrated from the hand-off cache, fetch silently in the
  // background so the user sees instant content. Otherwise fetch with spinner.
  useEffect(() => {
    loadAnalysis({ silent: !!initialAnalysis });
  }, [loadAnalysis]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!analysis) return;
    const existing = allLiveStats[fixtureId];
    if (existing && (existing.corners || existing.yellowCards || existing.goalScorers?.length || existing.cardEvents?.length)) return;

    const loadStats = async () => {
      try {
        const isFinished = ['FT', 'AET', 'PEN'].includes(analysis?.status?.short);
        if (!isFinished) {
          const refreshRes = await fetch('/api/refresh-live', { method: 'POST' });
          const refreshData = await refreshRes.json();
          if (refreshData.liveStats && Object.keys(refreshData.liveStats).length > 0) {
            setLiveStats(prev => ({ ...prev, ...refreshData.liveStats }));
            return;
          }
        }
        const res = await fetch(`/api/live-poll?fixtureId=${fixtureId}`);
        const data = await res.json();
        const matchStats = data.liveStats?.find(s => Number(s.fixtureId) === Number(fixtureId));
        if (matchStats) {
          setLiveStats(prev => ({ ...prev, [fixtureId]: matchStats }));
          return;
        }
        const fetchRes = await fetch(`/api/match/${fixtureId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'refresh-stats' }),
        });
        const fetchData = await fetchRes.json();
        if (fetchData.stats) {
          setLiveStats(prev => ({ ...prev, [fixtureId]: fetchData.stats }));
        }
      } catch {}
    };

    loadStats();
  }, [fixtureId, !!analysis]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const stats = allLiveStats[fixtureId];
    if (!stats?.status) return;
    setAnalysis(prev => prev ? ({
      ...prev,
      status: stats.status,
      goals: stats.goals || prev.goals,
    }) : prev);
  }, [allLiveStats[fixtureId]?.status?.short, allLiveStats[fixtureId]?.goals?.home, allLiveStats[fixtureId]?.goals?.away]); // eslint-disable-line react-hooks/exhaustive-deps

  const [lineupsError, setLineupsError] = useState('');

  const doRefreshLineups = async () => {
    setRefreshingLineups(true);
    setLineupsError('');
    try {
      const res = await fetch(`/api/match/${fixtureId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh-lineups' }),
      });
      const data = await res.json();
      if (data.error) {
        setLineupsError(data.error);
      } else if (data.lineups) {
        setAnalysis(prev => ({ ...prev, lineups: data.lineups }));
        if (!data.lineups.available) setLineupsError('Alineaciones aún no disponibles en la API');
      }
      if (data.quota) setQuota(data.quota);
    } catch (e) {
      setLineupsError('Error de conexión al actualizar alineaciones');
    } finally { setRefreshingLineups(false); }
  };

  const doRefreshInjuries = async () => {
    setRefreshingInjuries(true);
    try {
      const res = await fetch(`/api/match/${fixtureId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh-injuries' }),
      });
      const data = await res.json();
      if (data.injuries) setAnalysis(prev => ({ ...prev, injuries: data.injuries }));
      if (data.quota) setQuota(data.quota);
    } catch {} finally { setRefreshingInjuries(false); }
  };

  // ── LOADING ──
  if (loading) {
    return (
      <div style={{ minHeight: '100vh', position: 'relative', overflow: 'hidden', color: 'white' }}>
        <div style={{ position: 'fixed', inset: 0, zIndex: 0, background: 'linear-gradient(181deg, #030000 10%, #000009 14%, #1E8769 67%)' }} />
        <div style={{ position: 'relative', zIndex: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', flexDirection: 'column', gap: 16 }}>
          <div className="ap2-spinner" />
          <span style={{  color: 'white', fontSize: '.9rem' }}>Cargando análisis…</span>
        </div>
      </div>
    );
  }

  // ── NOT ANALYZED YET ──
  if (notAnalyzed) {
    return (
      <div style={{ minHeight: '100vh', position: 'relative', overflow: 'hidden', color: 'white' }}>
        <div style={{ position: 'fixed', inset: 0, zIndex: 0, background: 'linear-gradient(181deg, #030000 10%, #000009 14%, #1E8769 67%)' }} />
        <div style={{ position: 'relative', zIndex: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', flexDirection: 'column', gap: 16, padding: 24 }}>
          <div className="ap2-glass" style={{ maxWidth: 400, width: '100%', textAlign: 'center', padding: 32 }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🔍</div>
            <h3 style={{ fontWeight: 700, marginBottom: 8 }}>Partido sin analizar</h3>
            <p style={{ color: 'rgba(255,255,255,0.6)', marginBottom: 24, fontSize: '.9rem' }}>
              Este partido aún no tiene análisis. Puedes generarlo ahora.
            </p>
            {error && (
              <p style={{ color: '#ef4444', fontSize: '.85rem', marginBottom: 16 }}>{error}</p>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <motion.button
                className="ap2-back-btn"
                onClick={() => router.push('/dashboard')}
                whileHover={{ scale: 1.05 }} whileTap={{ scale: .95 }}
              >
                <ChevronLeft size={16} /> Volver
              </motion.button>
              <motion.button
                style={{ padding: '10px 22px', borderRadius: 10, background: analyzing ? 'rgba(34,211,238,0.3)' : 'linear-gradient(to right, #1E8769, #22d3ee)', border: 'none', color: 'white', fontWeight: 700, cursor: analyzing ? 'not-allowed' : 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 8 }}
                onClick={doAnalyze}
                disabled={analyzing}
                whileHover={analyzing ? {} : { scale: 1.05 }}
                whileTap={analyzing ? {} : { scale: .95 }}
              >
                {analyzing ? (
                  <><span className="ap2-spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Analizando...</>
                ) : (
                  <><Zap size={16} /> Analizar partido</>
                )}
              </motion.button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── ERROR ──
  if (error) {
    return (
      <div style={{ minHeight: '100vh', position: 'relative', overflow: 'hidden', color: 'white' }}>
        <div style={{ position: 'fixed', inset: 0, zIndex: 0, background: 'linear-gradient(181deg, #030000 10%, #000009 14%, #1E8769 67%)' }} />
        <div style={{ position: 'relative', zIndex: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', flexDirection: 'column', gap: 16, padding: 24 }}>
          <div className="ap2-glass" style={{ maxWidth: 400, width: '100%', textAlign: 'center' }}>
            <AlertTriangle style={{ width: 48, height: 48, color: '#ef4444', margin: '0 auto 16px' }} />
            <h3 style={{ fontWeight: 700, marginBottom: 8 }}>Error</h3>
            <p style={{  color: 'white', marginBottom: 20 }}>{error}</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <motion.button
                className="ap2-back-btn"
                onClick={() => router.push('/dashboard')}
                whileHover={{ scale: 1.05 }} whileTap={{ scale: .95 }}
              >
                <ChevronLeft size={16} /> Volver
              </motion.button>
              <motion.button
                style={{ padding: '8px 18px', borderRadius: 10, background: 'linear-gradient(to right, #00d4ff, #3b82f6)', border: 'none', color: 'white', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
                onClick={loadAnalysis}
                whileHover={{ scale: 1.05 }} whileTap={{ scale: .95 }}
              >
                Reintentar
              </motion.button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!analysis) return null;
  const a = analysis;
  const p = probabilities;
  const c = combinada;
  const statusShort = a.status?.short || 'NS';
  const live = isLiveStatus(statusShort);

  // Real-time elapsed: base elapsed from API + seconds since last update
  const clockRunning = isClockRunning(liveStatusShort || statusShort);
  const baseElapsed = liveStats?.status?.elapsed ?? (live ? (a.status?.elapsed || 0) : 0);
  const updatedAt = liveStats?.updatedAt;
  const secsSinceUpdate = (clockRunning && updatedAt) ? Math.max(0, Math.floor((Date.now() - new Date(updatedAt).getTime()) / 1000)) : 0;
  const liveMin = clockRunning ? Math.min(baseElapsed + Math.floor(secsSinceUpdate / 60), 120) : baseElapsed;
  const liveSec = clockRunning ? secsSinceUpdate % 60 : 0;

  return (
    <div className="ap2-page" style={{ minHeight: '100vh', position: 'relative', overflow: 'hidden', color: 'white', fontFamily: "'Inter', -apple-system, sans-serif" }}>
      {/* ── Fixed Animated Background ── */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 0, background: 'linear-gradient(181deg, #030000 10%, #000009 14%, #1E8769 67%)' }} />
      <motion.div
        className="ap2-orb"
        style={{ position: 'absolute', top: 0, left: 0, opacity: 0.35, filter: 'blur(80px)', background: 'radial-gradient(circle, rgba(30,135,105,0.6) 0%, transparent 70%)' }}
        animate={{ x: [0, 120, 0], y: [0, 180, 0], scale: [1, 1.25, 1] }}
        transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="ap2-orb"
        style={{ position: 'absolute', right: 0, top: '25%', opacity: 0.25, filter: 'blur(80px)', background: 'radial-gradient(circle, rgba(0,0,9,0.9) 0%, rgba(30,135,105,0.3) 70%)' }}
        animate={{ x: [0, -120, 0], y: [0, -120, 0], scale: [1, 1.35, 1] }}
        transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* ── Content ── */}
      <div style={{ position: 'relative', zIndex: 10 }}>

        {/* ── Sticky Header ── */}
        <motion.header
          className="ap2-header"
          initial={{ y: -80 }}
          animate={{ y: 0 }}
          transition={{ duration: .5 }}
        >
          <div className="ap2-header-inner">
            <motion.button
              className="ap2-back-btn"
              onClick={() => router.push('/dashboard')}
              whileHover={{ scale: 1.05, x: -4 }}
              whileTap={{ scale: .95 }}
            >
              <ChevronLeft size={18} />
              Volver
            </motion.button>
            {quota && (
              <motion.div
                className="ap2-quota-badge"
                animate={{ boxShadow: ['0 0 20px rgba(0,212,255,.3)', '0 0 30px rgba(0,212,255,.6)', '0 0 20px rgba(0,212,255,.3)'] }}
                transition={{ duration: 2, repeat: Infinity }}
              >
                Llamadas usadas hoy: <strong style={{ color: '#00d4ff' }}>{quota.used}</strong>
              </motion.div>
            )}
          </div>
        </motion.header>

        {/* ── Main Container ── */}
        <div className="ap2-main">

          {/* ══════════════════════════════════════════
              SECCIÓN 1 — CABECERA DEL PARTIDO
          ══════════════════════════════════════════ */}
          <motion.div
            className="ap2-glass"
            initial={{ opacity: 0, scale: .9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: .6 }}
          >
            {/* Glow overlay */}
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to right, rgba(30,135,105,.1), rgba(0,212,255,.08), rgba(168,85,247,.07))', borderRadius: 24, pointerEvents: 'none' }} />

            <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: 20 }}>

              {/* ── Fila 1: Liga + Fecha ── */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <motion.div
                  style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.85rem', fontWeight: 600 }}
                  animate={{ x: [0, 4, 0] }}
                  transition={{ duration: 2, repeat: Infinity }}
                >
                  {a.leagueLogo && <img src={a.leagueLogo} alt="" style={{ width: 20, height: 20, objectFit: 'contain' }} />}
                  <Trophy size={16} style={{ color: '#fbbf24', flexShrink: 0 }} />
                  <span>{a.league}</span>
                </motion.div>
                <span style={{ fontSize: '.8rem',  color: 'white' }}>{fmtDate(a.kickoff)}</span>
              </div>

              {/* ── Fila 2: Local | Cuotas | Visitante ── */}
              {/* En móvil: [Local | Visitante] en fila 1, [Cuotas] en fila 2 centrado */}
              {/* En desktop: [Local | Cuotas | Visitante] en una sola fila */}
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 12px' }}>
                {/* Local — order 1 */}
                <motion.div style={{ order: 1, flex: 1, minWidth: 0 }} whileHover={{ scale: 1.02 }}>
                  {a.homeLogo && <img src={a.homeLogo} alt="" style={{ width: 36, height: 36, objectFit: 'contain', marginBottom: 4 }} />}
                  <motion.div
                    style={{ fontSize: 'clamp(1rem, 3vw, 1.75rem)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 2 }}
                    animate={{ textShadow: ['0 0 10px rgba(30,135,105,.4)', '0 0 20px rgba(30,135,105,.7)', '0 0 10px rgba(30,135,105,.4)'] }}
                    transition={{ duration: 2, repeat: Infinity }}
                  >
                    {a.homeTeam}
                  </motion.div>
                  {a.homePosition && <div style={{ fontSize: '.72rem',  color: 'white' }}>{a.homePosition}° posición</div>}
                </motion.div>

                {/* Cuotas — order 3 en móvil (línea propia, ancho completo), order 2 en desktop */}
                {a.odds?.matchWinner && (
                  <div style={{ order: 3, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <OddsWithBookmaker odds={a.odds} allBookmakerOdds={a.odds?.allBookmakerOdds} userCountry={userCountry} />
                  </div>
                )}

                {/* Visitante — order 2 */}
                <motion.div style={{ order: 2, flex: 1, minWidth: 0, textAlign: 'right' }} whileHover={{ scale: 1.02 }}>
                  {a.awayLogo && <img src={a.awayLogo} alt="" style={{ width: 36, height: 36, objectFit: 'contain', marginBottom: 4, marginLeft: 'auto' }} />}
                  <div style={{ fontSize: 'clamp(1rem, 3vw, 1.75rem)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 2 }}>{a.awayTeam}</div>
                  {a.awayPosition && <div style={{ fontSize: '.72rem',  color: 'white' }}>{a.awayPosition}° posición</div>}
                </motion.div>
              </div>

              {/* ── Score Box ── */}
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <motion.div
                  style={{ width: '95%', borderRadius: 20, background: 'linear-gradient(135deg, rgba(30,135,105,.25), rgba(0,0,9,.4), rgba(30,135,105,.15))', border: '2px solid rgba(30,135,105,.5)', padding: '20px 24px', backdropFilter: 'blur(8px)' }}
                  animate={{ boxShadow: ['0 0 30px rgba(30,135,105,.3)', '0 0 50px rgba(30,135,105,.6)', '0 0 30px rgba(30,135,105,.3)'] }}
                  transition={{ duration: 2, repeat: Infinity }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>

                    {/* Badge de estado */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {live ? (
                        <>
                          <motion.div
                            className="ap2-live-badge"
                            animate={{ boxShadow: ['0 0 8px rgba(220,38,38,.6)', '0 0 18px rgba(220,38,38,1)', '0 0 8px rgba(220,38,38,.6)'] }}
                            transition={{ duration: 1.2, repeat: Infinity }}
                          >
                            <motion.span className="ap2-live-dot" animate={{ opacity: [1, .3, 1] }} transition={{ duration: 1, repeat: Infinity }} />
                            {(liveStatusShort === 'HT' || liveStatusShort === 'BT') ? 'ENTRETIEMPO' : 'EN VIVO'}
                            {clockRunning && liveMin > 0 && (
                              <span style={{ marginLeft: 4 }}>{liveMin}&apos;{String(liveSec).padStart(2, '0')}</span>
                            )}
                          </motion.div>
                          {clockRunning && liveStats?.status?.extra && (
                            <span style={{ fontSize: '.85rem', fontWeight: 700, color: '#fbbf24' }}>+{liveStats.status.extra} min</span>
                          )}
                        </>
                      ) : (
                        <div style={{ padding: '4px 14px', borderRadius: 999, background: 'rgba(255,255,255,.1)', fontSize: '.75rem', fontWeight: 700,  color: 'white', letterSpacing: '.05em' }}>
                          {statusLabel(statusShort)}
                        </div>
                      )}
                    </div>

                    {/* Marcador + stats al centro */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      {a.goals && a.goals.home !== null ? (
                        <>
                          {/* Gol local */}
                          <motion.span
                            style={{ fontSize: 'clamp(3rem, 10vw, 4.5rem)', fontWeight: 700, lineHeight: 1 }}
                            animate={{ textShadow: ['0 0 15px rgba(30,135,105,.5)', '0 0 25px rgba(30,135,105,1)', '0 0 15px rgba(30,135,105,.5)'] }}
                            transition={{ duration: 2, repeat: Infinity }}
                          >
                            {a.goals.home}
                          </motion.span>

                          {/* Stats: corners + tarjetas */}
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                            {liveStats?.corners && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8, background: 'rgba(255,255,255,.1)', fontSize: '.8rem', fontWeight: 700 }}>
                                <Flag size={14} style={{ color: '#fbbf24', flexShrink: 0 }} />
                                <span>{liveStats.corners.home}</span>
                                <span style={{  color: 'white' }}>-</span>
                                <span>{liveStats.corners.away}</span>
                                <span style={{  color: 'white', fontWeight: 400 }}>({liveStats.corners.home + liveStats.corners.away})</span>
                              </div>
                            )}
                            {liveStats?.yellowCards && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 8, background: 'rgba(255,255,255,.1)', fontSize: '.8rem', fontWeight: 700 }}>
                                <span style={{ color: '#fbbf24' }}>🟨{liveStats.yellowCards.home}</span>
                                <span style={{ color: '#ef4444' }}>🟥{liveStats.redCards?.home ?? 0}</span>
                                <span style={{  color: 'white' }}>|</span>
                                <span style={{ color: '#fbbf24' }}>🟨{liveStats.yellowCards.away}</span>
                                <span style={{ color: '#ef4444' }}>🟥{liveStats.redCards?.away ?? 0}</span>
                              </div>
                            )}
                          </div>

                          {/* Gol visitante */}
                          <span style={{ fontSize: 'clamp(3rem, 10vw, 4.5rem)', fontWeight: 700, lineHeight: 1 }}>{a.goals.away}</span>
                        </>
                      ) : (
                        /* Partido no iniciado: mostrar hora */
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontSize: 'clamp(1.8rem, 6vw, 3rem)', fontWeight: 700 }}>{fmtTime(a.kickoff)}</div>
                        </div>
                      )}
                    </div>

                    {/* Aggregate (vuelta de copa) */}
                    {(() => {
                      const round = a.leagueRound || '';
                      const is2ndLeg = /2nd leg/i.test(round);
                      const is1stLeg = /1st leg/i.test(round);
                      if (!is2ndLeg && !is1stLeg) return null;
                      const otherLeg = (a.h2h || []).find(h => {
                        const hRound = h.league?.round || '';
                        if (is2ndLeg) return /1st leg/i.test(hRound);
                        return /2nd leg/i.test(hRound);
                      });
                      if (!otherLeg) return null;
                      const legGoals = a.goals || {};
                      const otherGoals = otherLeg.goals || {};
                      let aggHome, aggAway;
                      if (is2ndLeg) {
                        const wasHomeIn1st = otherLeg.teams?.home?.id === a.homeId;
                        aggHome = (legGoals.home ?? 0) + (wasHomeIn1st ? (otherGoals.home ?? 0) : (otherGoals.away ?? 0));
                        aggAway = (legGoals.away ?? 0) + (wasHomeIn1st ? (otherGoals.away ?? 0) : (otherGoals.home ?? 0));
                      } else {
                        const wasHomeIn2nd = otherLeg.teams?.home?.id === a.homeId;
                        aggHome = (legGoals.home ?? 0) + (wasHomeIn2nd ? (otherGoals.home ?? 0) : (otherGoals.away ?? 0));
                        aggAway = (legGoals.away ?? 0) + (wasHomeIn2nd ? (otherGoals.away ?? 0) : (otherGoals.home ?? 0));
                      }
                      return (
                        <div className="ap2-agg">Global: {aggHome} - {aggAway}{is1stLeg && <small> (Ida)</small>}{is2ndLeg && <small> (Vuelta)</small>}</div>
                      );
                    })()}

                    {/* Goleadores, penales fallados y expulsiones — 2 columnas */}
                    {liveStats && (liveStats.goalScorers?.length > 0 || liveStats.missedPenalties?.length > 0 || liveStats.cardEvents?.some(c => c.type === 'Red Card')) && (
                      <div style={{ width: '100%', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
                        {/* Columna local */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          {liveStats.goalScorers?.filter(g => g.teamId === a.homeId).map((g, i) => (
                            <div key={i} style={{ fontSize: '.8rem', fontWeight: 600, color: '#6ee7b7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {g.minute}{g.extra ? `+${g.extra}` : ''}&#39; {g.player}{g.type === 'Penalty' ? ' (P)' : g.type === 'Own Goal' ? ' (AG)' : ''}
                            </div>
                          ))}
                          {liveStats.missedPenalties?.filter(p => p.teamId === a.homeId).map((p, i) => (
                            <div key={i} style={{ fontSize: '.8rem', fontWeight: 600, color: '#fb923c', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {p.player} ✗ pen. {p.minute}&#39;
                            </div>
                          ))}
                          {liveStats.cardEvents?.filter(c => c.teamId === a.homeId && c.type === 'Red Card').map((c, i) => (
                            <div key={i} style={{ fontSize: '.8rem', fontWeight: 600, color: '#ef4444', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              🟥 {c.player} {c.minute}&#39;
                            </div>
                          ))}
                        </div>
                        {/* Columna visitante */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'right' }}>
                          {liveStats.goalScorers?.filter(g => g.teamId !== a.homeId).map((g, i) => (
                            <div key={i} style={{ fontSize: '.8rem', fontWeight: 600, color: '#f1f5f9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {g.minute}{g.extra ? `+${g.extra}` : ''}&#39; {g.player}{g.type === 'Penalty' ? ' (P)' : g.type === 'Own Goal' ? ' (AG)' : ''}
                            </div>
                          ))}
                          {liveStats.missedPenalties?.filter(p => p.teamId !== a.homeId).map((p, i) => (
                            <div key={i} style={{ fontSize: '.8rem', fontWeight: 600, color: '#fb923c', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              ✗ pen. {p.minute}&#39; {p.player}
                            </div>
                          ))}
                          {liveStats.cardEvents?.filter(c => c.teamId !== a.homeId && c.type === 'Red Card').map((c, i) => (
                            <div key={i} style={{ fontSize: '.8rem', fontWeight: 600, color: '#ef4444', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {c.player} {c.minute}&#39; 🟥
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                  </div>
                </motion.div>
              </div>


            </div>
          </motion.div>

          {/* ══════════════════════════════════════════
              SECCIÓN 2 — ALINEACIONES
          ══════════════════════════════════════════ */}
          <GlassSection title="XI Alineación Titular" icon={<Users size={22} style={{ color: '#00d4ff' }} />} sectionKey="lineups" collapsed={collapsed} toggle={toggleSection} delay={.2}>
            {a.lineups?.available ? (
              <div className="ap2-lineups-grid">
                {a.lineups.data.map((team, idx) => (
                  <motion.div
                    key={idx}
                    className="ap2-inner"
                    style={{ background: idx === 0 ? 'rgba(0,212,255,.07)' : 'rgba(236,72,153,.07)', border: `1px solid ${idx === 0 ? 'rgba(0,212,255,.2)' : 'rgba(236,72,153,.2)'}` }}
                    initial={{ opacity: 0, x: idx === 0 ? -20 : 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: .3 + idx * .1 }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                      <TeamLogo src={team.team?.logo} name={team.team?.name} size={28} />
                      <span style={{ fontWeight: 700, fontSize: '.95rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{team.team?.name}</span>
                      <span style={{ marginLeft: 'auto', padding: '3px 8px', borderRadius: 6, background: 'rgba(255,255,255,.1)', fontSize: '.75rem', fontWeight: 700, flexShrink: 0 }}>{team.formation}</span>
                    </div>
                    <div style={{ fontSize: '.78rem',  color: 'white', marginBottom: 10 }}>DT: {team.coach?.name || 'N/A'}</div>
                    <div style={{ fontSize: '.78rem', fontWeight: 700,  color: 'white', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>Titulares</div>
                    {team.startXI?.map((pl, i) => (
                      <div key={i} className="ap2-player-row">
                        <div className="ap2-player-num">{pl.player?.number}</div>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pl.player?.name}</span>
                        <span className="ap2-player-pos">{pl.player?.pos}</span>
                      </div>
                    ))}
                    <div style={{ fontSize: '.78rem', fontWeight: 700,  color: 'white', textTransform: 'uppercase', letterSpacing: '.5px', margin: '12px 0 6px' }}>Suplentes</div>
                    {team.substitutes?.map((pl, i) => (
                      <div key={i} className="ap2-player-row" style={{ opacity: .7 }}>
                        <div className="ap2-player-num" style={{ background: 'rgba(255,255,255,.07)',  color: 'white' }}>{pl.player?.number}</div>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pl.player?.name}</span>
                        <span className="ap2-player-pos">{pl.player?.pos}</span>
                      </div>
                    ))}
                  </motion.div>
                ))}
              </div>
            ) : (
              <motion.div
                style={{ textAlign: 'center', padding: '32px 24px', borderRadius: 20, background: 'linear-gradient(135deg, rgba(249,115,22,.2), rgba(239,68,68,.2))', border: '1px solid rgba(249,115,22,.3)' }}
                whileHover={{ scale: 1.01 }}
              >
                <AlertTriangle size={48} style={{ color: '#fb923c', margin: '0 auto 12px' }} />
                <div style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: 16 }}>Alineaciones no disponibles aún</div>
                <motion.button
                  onClick={doRefreshLineups}
                  disabled={refreshingLineups}
                  style={{ padding: '10px 24px', borderRadius: 12, background: 'linear-gradient(to right, #00d4ff, #3b82f6)', border: 'none', color: 'white', fontWeight: 700, cursor: refreshingLineups ? 'not-allowed' : 'pointer', opacity: refreshingLineups ? .6 : 1, fontFamily: 'inherit', fontSize: '.9rem' }}
                  whileHover={!refreshingLineups ? { scale: 1.05, boxShadow: '0 0 20px rgba(0,212,255,.5)' } : {}}
                  whileTap={{ scale: .95 }}
                >
                  {refreshingLineups ? 'Actualizando…' : 'Actualizar alineaciones'}
                </motion.button>
                {lineupsError && <p style={{ color: '#ef4444', fontSize: '.82rem', marginTop: 10 }}>{lineupsError}</p>}
              </motion.div>
            )}
          </GlassSection>

          {/* ══════════════════════════════════════════
              SECCIÓN 3 — BAJAS
          ══════════════════════════════════════════ */}
          <GlassSection title="Bajas en el titular habitual" icon={<AlertTriangle size={22} style={{ color: '#ef4444' }} />} sectionKey="injuries" collapsed={collapsed} toggle={toggleSection} delay={.3}>
            <BajasSection
              filteredInjuries={a.filteredInjuries}
              allInjuries={a.injuries}
              homeTeam={a.homeTeam}
              awayTeam={a.awayTeam}
              onRefresh={doRefreshInjuries}
              refreshing={refreshingInjuries}
            />
          </GlassSection>

          {/* ══════════════════════════════════════════
              SECCIÓN 4 — ÚLTIMOS 5
          ══════════════════════════════════════════ */}
          {p && (
            <GlassSection title="Últimos 5 partidos" icon={<TrendingUp size={22} style={{ color: '#22c55e' }} />} sectionKey="last5" collapsed={collapsed} toggle={toggleSection} delay={.4}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
                <Last5Table team={a.homeTeam} logo={a.homeLogo} teamId={a.homeId} form={p.homeForm} lastFive={a.homeLastFive} accentColor="#00d4ff" />
                <Last5Table team={a.awayTeam} logo={a.awayLogo} teamId={a.awayId} form={p.awayForm} lastFive={a.awayLastFive} accentColor="#ec4899" />
              </div>
            </GlassSection>
          )}

          {/* ══════════════════════════════════════════
              SECCIÓN 5 — H2H
          ══════════════════════════════════════════ */}
          {p && (
            <GlassSection title="Historial H2H" icon={<History size={22} style={{ color: '#a855f7' }} />} sectionKey="h2h" collapsed={collapsed} toggle={toggleSection} delay={.5}>
              <H2HSection h2h={a.h2h} homeTeam={a.homeTeam} awayTeam={a.awayTeam} homeId={a.homeId} summary={p.h2hSummary} />
            </GlassSection>
          )}

          {/* ══════════════════════════════════════════
              SECCIÓN 6 — ESTADÍSTICAS CALCULADAS
          ══════════════════════════════════════════ */}
          {p && (
            <GlassSection title="Estadísticas calculadas" icon={<BarChart3 size={22} style={{ color: '#f97316' }} />} sectionKey="stats" collapsed={collapsed} toggle={toggleSection} delay={.6}>
              <div className="ap2-stats-grid">
                <StatCard
                  title={`Goles — ${a.homeTeam}`}
                  accentColor="rgba(0,212,255,.1)"
                  borderColor="rgba(0,212,255,.2)"
                  items={[
                    { label: 'Prom. anotados', value: p.homeGoals.avgScored, color: '#4ade80' },
                    { label: 'Prom. recibidos', value: p.homeGoals.avgConceded, color: '#f87171' },
                    { label: 'Prom. vs rival (H2H)', value: p.h2hGoals.homeAvg, color: '#67e8f9' },
                  ]}
                />
                <StatCard
                  title={`Goles — ${a.awayTeam}`}
                  accentColor="rgba(236,72,153,.1)"
                  borderColor="rgba(236,72,153,.2)"
                  items={[
                    { label: 'Prom. anotados', value: p.awayGoals.avgScored, color: '#4ade80' },
                    { label: 'Prom. recibidos', value: p.awayGoals.avgConceded, color: '#f87171' },
                    { label: 'Prom. vs rival (H2H)', value: p.h2hGoals.awayAvg, color: '#f472b6' },
                  ]}
                />
                <StatCard
                  title="Córners (últimos 5)"
                  accentColor="rgba(34,197,94,.1)"
                  borderColor="rgba(34,197,94,.2)"
                  items={[
                    { label: `${a.homeTeam} a favor`, value: p.cornerCardData?.homeCornersAvg ?? '—' },
                    { label: `${a.homeTeam} en contra`, value: p.cornerCardData?.homeCornersAgainstAvg ?? '—' },
                    { label: `${a.awayTeam} a favor`, value: p.cornerCardData?.awayCornersAvg ?? '—' },
                    { label: `${a.awayTeam} en contra`, value: p.cornerCardData?.awayCornersAgainstAvg ?? '—' },
                    { label: 'Total combinado', value: p.cornerAvg, color: '#4ade80' },
                  ]}
                />
                <StatCard
                  title="Tarjetas (últimos 5)"
                  accentColor="rgba(245,158,11,.1)"
                  borderColor="rgba(245,158,11,.2)"
                  items={[
                    { label: `${a.homeTeam} amarillas`, value: p.cornerCardData?.homeYellowsAvg ?? '—' },
                    { label: `${a.homeTeam} rojas`, value: p.cornerCardData?.homeRedsAvg ?? '—' },
                    { label: `${a.awayTeam} amarillas`, value: p.cornerCardData?.awayYellowsAvg ?? '—' },
                    { label: `${a.awayTeam} rojas`, value: p.cornerCardData?.awayRedsAvg ?? '—' },
                    { label: 'Total amarillas prom.', value: p.cardAvg, color: '#fbbf24' },
                  ]}
                />
              </div>
            </GlassSection>
          )}

          {/* ══════════════════════════════════════════
              SECCIÓN 6B — ESTADÍSTICAS POR EQUIPO
          ══════════════════════════════════════════ */}
          {p?.perTeam && (
            <GlassSection title="Estadísticas por equipo" icon={<Scale size={22} style={{ color: '#3b82f6' }} />} sectionKey="perteam" collapsed={collapsed} toggle={toggleSection} delay={.65}>
              <PerTeamSection perTeam={p.perTeam} homeTeam={a.homeTeam} awayTeam={a.awayTeam} homeLogo={a.homeLogo} awayLogo={a.awayLogo} />
            </GlassSection>
          )}

          {/* ══════════════════════════════════════════
              SECCIÓN 6C — TIMING DE GOL
          ══════════════════════════════════════════ */}
          {p?.goalTiming && (
            <GlassSection title="Probabilidad de gol por periodo" icon={<Clock size={22} style={{ color: '#6366f1' }} />} sectionKey="timing" collapsed={collapsed} toggle={toggleSection} delay={.7}>
              <GoalTimingSection goalTiming={p.goalTiming} homeTeam={a.homeTeam} awayTeam={a.awayTeam} />
            </GlassSection>
          )}

          {/* ══════════════════════════════════════════
              SECCIÓN 7 — JUGADORES DESTACADOS
          ══════════════════════════════════════════ */}
          <GlassSection title="Jugadores destacados" icon={<Star size={22} style={{ color: '#fbbf24' }} />} sectionKey="players" collapsed={collapsed} toggle={toggleSection} delay={.75}>
            <PlayerHighlights highlights={a.playerHighlights} />
          </GlassSection>

          {/* ══════════════════════════════════════════
              SECCIÓN 8 — PROBABILIDADES CALCULADAS
          ══════════════════════════════════════════ */}
          {p && (() => {
            // Solo mostrar opciones cuya cuota exista en al menos una de las 8 casas autorizadas.
            const o = a.odds || {};
            const hasOdd = (v) => isFinite(parseFloat(v)) && parseFloat(v) > 1;
            const cats = [
              {
                title: 'Ambos marcan (BTTS)',
                items: [
                  hasOdd(o.btts?.yes) && { label: 'Sí', value: p.btts },
                  hasOdd(o.btts?.no)  && { label: 'No', value: p.bttsNo },
                ].filter(Boolean),
              },
              {
                title: 'Ganador del partido',
                items: [
                  hasOdd(o.matchWinner?.home) && { label: a.homeTeam, value: p.winner.home },
                  hasOdd(o.matchWinner?.draw) && { label: 'Empate',   value: p.winner.draw },
                  hasOdd(o.matchWinner?.away) && { label: a.awayTeam, value: p.winner.away },
                ].filter(Boolean),
              },
              {
                title: 'Goles totales del partido',
                subtitle: `Esperado: ${p.overUnder.expectedTotal} goles`,
                items: [
                  hasOdd(o.overUnder?.['Over_1_5']) && { label: 'Total partido — Más de 1.5', value: p.overUnder.over15 },
                  hasOdd(o.overUnder?.['Over_2_5']) && { label: 'Total partido — Más de 2.5', value: p.overUnder.over25 },
                  hasOdd(o.overUnder?.['Over_3_5']) && { label: 'Total partido — Más de 3.5', value: p.overUnder.over35 },
                ].filter(Boolean),
              },
              {
                title: 'Goles por equipo',
                items: [
                  hasOdd(o.homeGoals?.['Over_0_5']) && p.perTeam?.home?.goals && { label: `Local (${a.homeTeam}) — Más de 0.5`,     value: p.perTeam.home.goals.over05 },
                  hasOdd(o.homeGoals?.['Over_1_5']) && p.perTeam?.home?.goals && { label: `Local (${a.homeTeam}) — Más de 1.5`,     value: p.perTeam.home.goals.over15 },
                  hasOdd(o.homeGoals?.['Over_2_5']) && p.perTeam?.home?.goals && { label: `Local (${a.homeTeam}) — Más de 2.5`,     value: p.perTeam.home.goals.over25 },
                  hasOdd(o.awayGoals?.['Over_0_5']) && p.perTeam?.away?.goals && { label: `Visitante (${a.awayTeam}) — Más de 0.5`, value: p.perTeam.away.goals.over05 },
                  hasOdd(o.awayGoals?.['Over_1_5']) && p.perTeam?.away?.goals && { label: `Visitante (${a.awayTeam}) — Más de 1.5`, value: p.perTeam.away.goals.over15 },
                  hasOdd(o.awayGoals?.['Over_2_5']) && p.perTeam?.away?.goals && { label: `Visitante (${a.awayTeam}) — Más de 2.5`, value: p.perTeam.away.goals.over25 },
                ].filter(Boolean),
              },
              {
                title: 'Córners totales del partido',
                items: [
                  hasOdd(o.corners?.['Over_8_5'])  && { label: 'Total partido — Más de 8.5',  value: p.corners.over85  },
                  hasOdd(o.corners?.['Over_9_5'])  && { label: 'Total partido — Más de 9.5',  value: p.corners.over95  },
                  hasOdd(o.corners?.['Over_10_5']) && { label: 'Total partido — Más de 10.5', value: p.corners.over105 },
                ].filter(Boolean),
              },
              {
                title: 'Córners por equipo',
                items: [
                  hasOdd(o.homeCorners?.['Over_3_5']) && p.perTeam?.home?.corners && { label: `Local (${a.homeTeam}) — Más de 3.5`,     value: p.perTeam.home.corners.over35 },
                  hasOdd(o.homeCorners?.['Over_4_5']) && p.perTeam?.home?.corners && { label: `Local (${a.homeTeam}) — Más de 4.5`,     value: p.perTeam.home.corners.over45 },
                  hasOdd(o.homeCorners?.['Over_5_5']) && p.perTeam?.home?.corners && { label: `Local (${a.homeTeam}) — Más de 5.5`,     value: p.perTeam.home.corners.over55 },
                  hasOdd(o.awayCorners?.['Over_3_5']) && p.perTeam?.away?.corners && { label: `Visitante (${a.awayTeam}) — Más de 3.5`, value: p.perTeam.away.corners.over35 },
                  hasOdd(o.awayCorners?.['Over_4_5']) && p.perTeam?.away?.corners && { label: `Visitante (${a.awayTeam}) — Más de 4.5`, value: p.perTeam.away.corners.over45 },
                  hasOdd(o.awayCorners?.['Over_5_5']) && p.perTeam?.away?.corners && { label: `Visitante (${a.awayTeam}) — Más de 5.5`, value: p.perTeam.away.corners.over55 },
                ].filter(Boolean),
              },
              {
                title: 'Tarjetas totales del partido',
                items: [
                  hasOdd(o.cards?.['Over_2_5']) && { label: 'Total partido — Más de 2.5', value: p.cards.over25 },
                  hasOdd(o.cards?.['Over_3_5']) && { label: 'Total partido — Más de 3.5', value: p.cards.over35 },
                  hasOdd(o.cards?.['Over_4_5']) && { label: 'Total partido — Más de 4.5', value: p.cards.over45 },
                ].filter(Boolean),
              },
              {
                title: 'Tarjetas por equipo',
                items: [
                  hasOdd(o.homeCards?.['Over_0_5']) && p.perTeam?.home?.cards && { label: `Local (${a.homeTeam}) — Más de 0.5`,     value: p.perTeam.home.cards.over05 },
                  hasOdd(o.homeCards?.['Over_1_5']) && p.perTeam?.home?.cards && { label: `Local (${a.homeTeam}) — Más de 1.5`,     value: p.perTeam.home.cards.over15 },
                  hasOdd(o.homeCards?.['Over_2_5']) && p.perTeam?.home?.cards && { label: `Local (${a.homeTeam}) — Más de 2.5`,     value: p.perTeam.home.cards.over25 },
                  hasOdd(o.awayCards?.['Over_0_5']) && p.perTeam?.away?.cards && { label: `Visitante (${a.awayTeam}) — Más de 0.5`, value: p.perTeam.away.cards.over05 },
                  hasOdd(o.awayCards?.['Over_1_5']) && p.perTeam?.away?.cards && { label: `Visitante (${a.awayTeam}) — Más de 1.5`, value: p.perTeam.away.cards.over15 },
                  hasOdd(o.awayCards?.['Over_2_5']) && p.perTeam?.away?.cards && { label: `Visitante (${a.awayTeam}) — Más de 2.5`, value: p.perTeam.away.cards.over25 },
                ].filter(Boolean),
              },

              // ──────── Mercados NUEVOS (cache_version 9) ────────
              // Goles por mitad
              {
                title: 'Goles 1ª parte',
                subtitle: p.halfGoals?.firstHalf?.expected != null ? `Esperado: ${p.halfGoals.firstHalf.expected} goles` : null,
                items: [
                  hasOdd(o.goals1H?.['Over_0_5']) && p.halfGoals?.firstHalf && { label: '1ª Parte — Más de 0.5', value: p.halfGoals.firstHalf.over05 },
                  hasOdd(o.goals1H?.['Over_1_5']) && p.halfGoals?.firstHalf && { label: '1ª Parte — Más de 1.5', value: p.halfGoals.firstHalf.over15 },
                  hasOdd(o.goals1H?.['Over_2_5']) && p.halfGoals?.firstHalf && { label: '1ª Parte — Más de 2.5', value: p.halfGoals.firstHalf.over25 },
                ].filter(Boolean),
              },
              {
                title: 'Goles 2ª parte',
                subtitle: p.halfGoals?.secondHalf?.expected != null ? `Esperado: ${p.halfGoals.secondHalf.expected} goles` : null,
                items: [
                  hasOdd(o.goals2H?.['Over_0_5']) && p.halfGoals?.secondHalf && { label: '2ª Parte — Más de 0.5', value: p.halfGoals.secondHalf.over05 },
                  hasOdd(o.goals2H?.['Over_1_5']) && p.halfGoals?.secondHalf && { label: '2ª Parte — Más de 1.5', value: p.halfGoals.secondHalf.over15 },
                  hasOdd(o.goals2H?.['Over_2_5']) && p.halfGoals?.secondHalf && { label: '2ª Parte — Más de 2.5', value: p.halfGoals.secondHalf.over25 },
                ].filter(Boolean),
              },
              // 1X2 por mitad
              {
                title: 'Ganador 1ª parte',
                items: [
                  hasOdd(o.winner1H?.home) && p.halfWinner?.firstHalf && { label: a.homeTeam, value: p.halfWinner.firstHalf.home },
                  hasOdd(o.winner1H?.draw) && p.halfWinner?.firstHalf && { label: 'Empate',   value: p.halfWinner.firstHalf.draw },
                  hasOdd(o.winner1H?.away) && p.halfWinner?.firstHalf && { label: a.awayTeam, value: p.halfWinner.firstHalf.away },
                ].filter(Boolean),
              },
              {
                title: 'Ganador 2ª parte',
                items: [
                  hasOdd(o.winner2H?.home) && p.halfWinner?.secondHalf && { label: a.homeTeam, value: p.halfWinner.secondHalf.home },
                  hasOdd(o.winner2H?.draw) && p.halfWinner?.secondHalf && { label: 'Empate',   value: p.halfWinner.secondHalf.draw },
                  hasOdd(o.winner2H?.away) && p.halfWinner?.secondHalf && { label: a.awayTeam, value: p.halfWinner.secondHalf.away },
                ].filter(Boolean),
              },
              // Goles equipo por mitad
              {
                title: 'Goles equipo por mitad',
                items: [
                  hasOdd(o.homeGoals1H?.['Over_0_5']) && p.perTeamHalfGoals?.home?.firstHalf  && { label: `${a.homeTeam} marca 1ª Parte`, value: p.perTeamHalfGoals.home.firstHalf.over05 },
                  hasOdd(o.awayGoals1H?.['Over_0_5']) && p.perTeamHalfGoals?.away?.firstHalf  && { label: `${a.awayTeam} marca 1ª Parte`, value: p.perTeamHalfGoals.away.firstHalf.over05 },
                  hasOdd(o.homeGoals2H?.['Over_0_5']) && p.perTeamHalfGoals?.home?.secondHalf && { label: `${a.homeTeam} marca 2ª Parte`, value: p.perTeamHalfGoals.home.secondHalf.over05 },
                  hasOdd(o.awayGoals2H?.['Over_0_5']) && p.perTeamHalfGoals?.away?.secondHalf && { label: `${a.awayTeam} marca 2ª Parte`, value: p.perTeamHalfGoals.away.secondHalf.over05 },
                ].filter(Boolean),
              },
              // Tiros totales y on target
              p.shots && {
                title: 'Tiros totales del partido',
                subtitle: p.shots._mean ? `Esperado: ${p.shots._mean} tiros` : null,
                items: (p.shots._lines || []).map(line => {
                  const key = `over${String(line).replace('.', '_')}`;
                  const oddKey = `Over_${String(line).replace('.', '_')}`;
                  if (!hasOdd(o.shots?.[oddKey]) || p.shots[key] == null) return null;
                  return { label: `Total partido — Más de ${line}`, value: p.shots[key] };
                }).filter(Boolean),
              },
              p.sot && {
                title: 'Tiros a puerta del partido',
                subtitle: p.sot._mean ? `Esperado: ${p.sot._mean} tiros a puerta` : null,
                items: (p.sot._lines || []).map(line => {
                  const key = `over${String(line).replace('.', '_')}`;
                  const oddKey = `Over_${String(line).replace('.', '_')}`;
                  if (!hasOdd(o.sot?.[oddKey]) || p.sot[key] == null) return null;
                  return { label: `Total partido — Más de ${line} a puerta`, value: p.sot[key] };
                }).filter(Boolean),
              },
              // Tiros por equipo
              p.perTeamShots?.home && {
                title: `Tiros — ${a.homeTeam}`,
                items: (p.perTeamShots.home._lines || []).map(line => {
                  const key = `over${String(line).replace('.', '_')}`;
                  const oddKey = `Over_${String(line).replace('.', '_')}`;
                  if (!hasOdd(o.homeShots?.[oddKey]) || p.perTeamShots.home[key] == null) return null;
                  return { label: `Local (${a.homeTeam}) — Más de ${line}`, value: p.perTeamShots.home[key] };
                }).filter(Boolean),
              },
              p.perTeamShots?.away && {
                title: `Tiros — ${a.awayTeam}`,
                items: (p.perTeamShots.away._lines || []).map(line => {
                  const key = `over${String(line).replace('.', '_')}`;
                  const oddKey = `Over_${String(line).replace('.', '_')}`;
                  if (!hasOdd(o.awayShots?.[oddKey]) || p.perTeamShots.away[key] == null) return null;
                  return { label: `Visitante (${a.awayTeam}) — Más de ${line}`, value: p.perTeamShots.away[key] };
                }).filter(Boolean),
              },
              // Faltas totales
              p.fouls && {
                title: 'Faltas totales del partido',
                subtitle: p.fouls._mean ? `Esperado: ${p.fouls._mean} faltas` : null,
                items: (p.fouls._lines || []).map(line => {
                  const key = `over${String(line).replace('.', '_')}`;
                  const oddKey = `Over_${String(line).replace('.', '_')}`;
                  if (!hasOdd(o.fouls?.[oddKey]) || p.fouls[key] == null) return null;
                  return { label: `Total partido — Más de ${line} faltas`, value: p.fouls[key] };
                }).filter(Boolean),
              },
              p.perTeamFouls?.home && {
                title: `Faltas — ${a.homeTeam}`,
                items: (p.perTeamFouls.home._lines || []).map(line => {
                  const key = `over${String(line).replace('.', '_')}`;
                  const oddKey = `Over_${String(line).replace('.', '_')}`;
                  if (!hasOdd(o.homeFouls?.[oddKey]) || p.perTeamFouls.home[key] == null) return null;
                  return { label: `Local (${a.homeTeam}) — Más de ${line} faltas`, value: p.perTeamFouls.home[key] };
                }).filter(Boolean),
              },
              p.perTeamFouls?.away && {
                title: `Faltas — ${a.awayTeam}`,
                items: (p.perTeamFouls.away._lines || []).map(line => {
                  const key = `over${String(line).replace('.', '_')}`;
                  const oddKey = `Over_${String(line).replace('.', '_')}`;
                  if (!hasOdd(o.awayFouls?.[oddKey]) || p.perTeamFouls.away[key] == null) return null;
                  return { label: `Visitante (${a.awayTeam}) — Más de ${line} faltas`, value: p.perTeamFouls.away[key] };
                }).filter(Boolean),
              },
              // Equipo con más córners (full / 1H / 2H)
              p.mostCorners && {
                title: 'Equipo con más córners',
                items: [
                  hasOdd(o.corners1x2?.home) && p.mostCorners.fullMatch && { label: a.homeTeam, value: p.mostCorners.fullMatch.home },
                  hasOdd(o.corners1x2?.draw) && p.mostCorners.fullMatch && { label: 'Empate', value: p.mostCorners.fullMatch.draw },
                  hasOdd(o.corners1x2?.away) && p.mostCorners.fullMatch && { label: a.awayTeam, value: p.mostCorners.fullMatch.away },
                  hasOdd(o.corners1x21H?.home) && p.mostCorners.firstHalf && { label: `1ª Parte — ${a.homeTeam}`, value: p.mostCorners.firstHalf.home },
                  hasOdd(o.corners1x21H?.away) && p.mostCorners.firstHalf && { label: `1ª Parte — ${a.awayTeam}`, value: p.mostCorners.firstHalf.away },
                  hasOdd(o.corners1x22H?.home) && p.mostCorners.secondHalf && { label: `2ª Parte — ${a.homeTeam}`, value: p.mostCorners.secondHalf.home },
                  hasOdd(o.corners1x22H?.away) && p.mostCorners.secondHalf && { label: `2ª Parte — ${a.awayTeam}`, value: p.mostCorners.secondHalf.away },
                ].filter(Boolean),
              },
              // Asian Handicap — itera por las claves disponibles en odds
              p.asianHandicap && o.asianHandicap && {
                title: 'Hándicap Asiático',
                items: Object.keys(o.asianHandicap).map(oddKey => {
                  if (!hasOdd(o.asianHandicap[oddKey])) return null;
                  const m = oddKey.match(/^(home|away)_([mp])(\d+(?:_\d+)?)$/);
                  if (!m) return null;
                  const side = m[1];
                  const sign = m[2] === 'm' ? -1 : 1;
                  const lineNum = sign * parseFloat(m[3].replace('_', '.'));
                  const probKey = `h${oddKey.slice(oddKey.indexOf('_') + 1)}`;
                  const prob = p.asianHandicap[side]?.[probKey];
                  if (prob == null) return null;
                  const teamName = side === 'home' ? a.homeTeam : a.awayTeam;
                  return { label: `${teamName} ${lineNum > 0 ? '+' : ''}${lineNum}`, value: prob };
                }).filter(Boolean),
              },
            ].filter(Boolean).filter(c => c.items.length > 0);

            if (cats.length === 0) return null;

            return (
              <GlassSection title="% Probabilidades calculadas" icon={<Percent size={22} style={{ color: '#2dd4bf' }} />} sectionKey="probs" collapsed={collapsed} toggle={toggleSection} delay={.8}>
                <div className="ap2-prob-grid">
                  {cats.map((cat, catIdx) => (
                    <motion.div
                      key={catIdx}
                      className="ap2-prob-inner"
                      style={{ background: 'linear-gradient(135deg, rgba(45,212,191,.07), rgba(0,212,255,.07))', border: '1px solid rgba(45,212,191,.2)' }}
                      initial={{ opacity: 0, scale: .9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: .85 + catIdx * .08 }}
                      whileHover={{ scale: 1.02 }}
                    >
                      <div style={{ fontWeight: 700, marginBottom: 4, fontSize: '.95rem' }}>{cat.title}</div>
                      {cat.subtitle && <div style={{ fontSize: '.75rem',  color: 'white', marginBottom: 10 }}>{cat.subtitle}</div>}
                      <div style={{ marginTop: 10 }}>
                        {cat.items.map((item, i) => (
                          <ProbBar key={i} label={item.label} value={item.value} delay={.9 + catIdx * .08 + i * .03} />
                        ))}
                      </div>
                    </motion.div>
                  ))}
                </div>
              </GlassSection>
            );
          })()}

          {/* ══════════════════════════════════════════
              SECCIÓN 9 — COMBINADA AUTOMÁTICA
          ══════════════════════════════════════════ */}
          {(() => {
            if (!c || c.selections.length === 0) return null;
            const allSels = c.selections;
            const matchName = `${a.homeTeam} vs ${a.awayTeam}`;
            const withOdds = allSels.filter(s => s.odd && s.odd > 1);
            const cOdd = withOdds.length >= 1 ? withOdds.reduce((acc, s) => acc * s.odd, 1) : null;
            const cProb = allSels.reduce((acc, s) => acc + s.probability, 0) / allSels.length;
            const isHighRisk = cProb < 70;
            const inCombo = selectedMarkets[fixtureId] || {};
            const addedCount = Object.keys(inCombo).length;
            return (
              <motion.div
                className="ap2-glass"
                style={{ background: 'rgba(255,255,255,.04)' }}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: .9 }}
              >
                {/* Animated gradient background */}
                <motion.div
                  style={{ position: 'absolute', inset: 0, borderRadius: 24, background: 'linear-gradient(to right, rgba(234,179,8,.08), rgba(249,115,22,.08), rgba(239,68,68,.08))', pointerEvents: 'none' }}
                  animate={{ opacity: [.6, 1, .6] }}
                  transition={{ duration: 3, repeat: Infinity }}
                />

                <div style={{ position: 'relative', zIndex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <motion.h3
                      style={{ fontSize: '1.3rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10 }}
                      animate={{ textShadow: ['0 0 10px rgba(234,179,8,.5)', '0 0 20px rgba(234,179,8,.8)', '0 0 10px rgba(234,179,8,.5)'] }}
                      transition={{ duration: 2, repeat: Infinity }}
                    >
                      <Trophy size={26} style={{ color: '#fbbf24' }} />
                      🏆 Combinada automática
                    </motion.h3>
                    {addedCount > 0 && (
                      <div style={{ padding: '5px 12px', borderRadius: 999, background: 'rgba(34,197,94,.2)', border: '1px solid rgba(34,197,94,.4)', fontSize: '.78rem', fontWeight: 700, color: '#4ade80' }}>
                        {addedCount} en tu combinada
                      </div>
                    )}
                  </div>
                  <p style={{ fontSize: '.78rem',  color: 'white', marginBottom: 20 }}>
                    Toca para añadir a tu combinada
                  </p>

                  <div style={{ marginBottom: 20 }}>
                    {allSels.map((sel, i) => {
                      const active = !!inCombo[sel.id];
                      return (
                        <motion.button
                          key={sel.id}
                          onClick={() => toggleMarket(fixtureId, sel, matchName)}
                          style={{ width: '100%', position: 'relative', overflow: 'hidden', padding: '18px 20px', borderRadius: 16, background: 'linear-gradient(to right, rgba(234,179,8,.2), rgba(249,115,22,.2), rgba(239,68,68,.2))', border: `2px solid ${active ? 'rgba(34,197,94,.7)' : 'rgba(234,179,8,.4)'}`, marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer', textAlign: 'left', color: 'inherit', font: 'inherit', outline: 'none' }}
                          initial={{ opacity: 0, x: -30 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: .95 + i * .08 }}
                          whileHover={{ scale: 1.02, borderColor: 'rgba(250,204,21,.6)' }}
                          whileTap={{ scale: 0.98 }}
                        >
                          {/* Shimmer */}
                          <motion.div
                            style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to right, transparent, rgba(255,255,255,.08), transparent)', pointerEvents: 'none' }}
                            animate={{ x: [-200, 500] }}
                            transition={{ duration: 3, repeat: Infinity, delay: i * .5 }}
                          />
                          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0, position: 'relative', zIndex: 1 }}>
                            <span style={{ fontSize: '1.4rem', fontWeight: 700, color: '#fbbf24', minWidth: 32 }}>
                              {String(i + 1).padStart(2, '0')}
                            </span>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 700, fontSize: '1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sel.name}</div>
                              {sel.odd && sel.odd > 1 && <div style={{ fontSize: '.78rem',  color: 'white' }}>Cuota: {sel.odd.toFixed(2)}</div>}
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, position: 'relative', zIndex: 1 }}>
                            {active && <Check size={16} style={{ color: '#22c55e' }} />}
                            <motion.div
                              style={{ padding: '10px 18px', borderRadius: 12, background: 'linear-gradient(135deg, #22c55e, #16a34a)', fontWeight: 700, fontSize: '1.3rem', color: 'white' }}
                              animate={{ scale: [1, 1.05, 1], boxShadow: ['0 0 20px rgba(34,197,94,.5)', '0 0 30px rgba(34,197,94,.8)', '0 0 20px rgba(34,197,94,.5)'] }}
                              transition={{ duration: 2, repeat: Infinity, delay: i * .2 }}
                            >
                              {cap(sel.probability)}%
                            </motion.div>
                          </div>
                        </motion.button>
                      );
                    })}
                  </div>

                  <motion.div
                    style={{ padding: '24px', borderRadius: 20, background: 'linear-gradient(135deg, rgba(168,85,247,.3), rgba(236,72,153,.3), rgba(239,68,68,.3))', border: '2px solid rgba(168,85,247,.5)', textAlign: 'center', position: 'relative', overflow: 'hidden' }}
                    initial={{ opacity: 0, scale: .9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 1.0 }}
                    whileHover={{ scale: 1.02 }}
                  >
                    <motion.div
                      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
                      animate={{ background: ['radial-gradient(circle at 20% 50%, rgba(168,85,247,.3) 0%, transparent 50%)', 'radial-gradient(circle at 80% 50%, rgba(236,72,153,.3) 0%, transparent 50%)', 'radial-gradient(circle at 20% 50%, rgba(168,85,247,.3) 0%, transparent 50%)'] }}
                      transition={{ duration: 4, repeat: Infinity }}
                    />
                    <div style={{ position: 'relative', zIndex: 1 }}>
                      {cOdd && (
                        <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 16px', borderRadius: 10, background: 'rgba(255,255,255,.1)' }}>
                          <span style={{ fontWeight: 600 }}>Cuota combinada</span>
                          <strong style={{ fontSize: '1.2rem', color: '#fbbf24' }}>{cOdd.toFixed(2)}</strong>
                        </div>
                      )}
                      {isHighRisk && (
                        <div style={{ marginBottom: 12, padding: '8px 14px', borderRadius: 10, background: 'rgba(234,179,8,.15)', border: '1px solid rgba(234,179,8,.3)', color: '#fbbf24', fontSize: '.82rem', fontWeight: 600 }}>
                          ⚠ Probabilidad combinada baja — alto riesgo
                        </div>
                      )}
                      <div style={{ fontSize: '1rem', fontWeight: 600,  color: 'white', marginBottom: 8 }}>Probabilidad media</div>
                      <motion.div
                        style={{ fontSize: '3.5rem', fontWeight: 700, color: isHighRisk ? '#f87171' : '#4ade80' }}
                        animate={{ scale: [1, 1.08, 1], textShadow: ['0 0 20px rgba(168,85,247,.5)', '0 0 40px rgba(168,85,247,1)', '0 0 20px rgba(168,85,247,.5)'] }}
                        transition={{ duration: 2, repeat: Infinity }}
                      >
                        {cap(cProb).toFixed(2)}%
                      </motion.div>
                    </div>
                  </motion.div>
                </div>
              </motion.div>
            );
          })()}

        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════
// GLASS SECTION WRAPPER
// ══════════════════════════════════════════
function GlassSection({ title, icon, sectionKey, collapsed, toggle, delay = 0, defaultOpen = false, children }) {
  const isCollapsed = sectionKey ? collapsed?.[sectionKey] : false;
  const handleToggle = () => { if (sectionKey && toggle) toggle(sectionKey); };

  return (
    <motion.div
      className="ap2-glass"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
    >
      {sectionKey ? (
        <button className="ap2-sec-btn" onClick={handleToggle} style={{ marginBottom: isCollapsed ? 0 : 20 }}>
          <span className="ap2-sec-title">
            {icon}
            {title}
          </span>
          <motion.div animate={{ rotate: isCollapsed ? 0 : 180 }} transition={{ duration: .25 }}>
            <ChevronDown size={20} style={{  color: 'white' }} />
          </motion.div>
        </button>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <span className="ap2-sec-title">{icon}{title}</span>
        </div>
      )}
      <AnimatePresence>
        {!isCollapsed && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: .25 }}
            style={{ overflow: 'hidden' }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ══════════════════════════════════════════
// TEAM LOGO
// ══════════════════════════════════════════
function TeamLogo({ src, name, size = 32 }) {
  const [err, setErr] = useState(false);
  if (!src || err) {
    return (
      <div style={{ width: size, height: size, borderRadius: size * .3, background: 'rgba(0,212,255,.2)', border: '1px solid rgba(0,212,255,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * .35, fontWeight: 700, color: '#00d4ff', flexShrink: 0 }}>
        {(name || '?').slice(0, 2).toUpperCase()}
      </div>
    );
  }
  return <img src={src} alt={name} width={size} height={size} style={{ objectFit: 'contain', flexShrink: 0 }} onError={() => setErr(true)} />;
}

// ══════════════════════════════════════════
// ODDS WITH BOOKMAKER
// ══════════════════════════════════════════
function OddsWithBookmaker({ odds, allBookmakerOdds, userCountry }) {
  const selected = selectBookmakerOdds(odds, 'matchWinner', userCountry);
  const mw = selected?.odds || odds.matchWinner;
  const bkName = selected?.bookmaker || odds.bookmaker;
  const bkNameLower = bkName ? bkName.toLowerCase() : '';
  const bkLogo = bkNameLower ? BOOKMAKER_LOGOS[bkNameLower] || Object.entries(BOOKMAKER_LOGOS).find(([k]) => bkNameLower.includes(k))?.[1] : null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'center', order: 3 }}>
      {bkName && (
        <motion.div
          style={{ padding: '4px 12px', borderRadius: 999, background: 'linear-gradient(to right, rgba(59,130,246,.2), rgba(168,85,247,.2))', border: '1px solid rgba(59,130,246,.3)', display: 'flex', alignItems: 'center', gap: 6, fontSize: '.75rem', fontWeight: 700 }}
          animate={{ opacity: [.6, 1, .6] }}
          transition={{ duration: 2, repeat: Infinity }}
        >
          {bkLogo && <img src={bkLogo} alt={bkName} style={{ height: 14, objectFit: 'contain' }} />}
          {!bkLogo && bkName}
          <Zap size={12} style={{ color: '#fbbf24' }} />
        </motion.div>
      )}
      {mw?.home && (
        <motion.div style={{ padding: '6px 14px', borderRadius: 10, background: 'linear-gradient(135deg, #22c55e, #16a34a)', fontWeight: 700, fontSize: '.9rem', cursor: 'default' }} whileHover={{ scale: 1.05 }}>
          {mw.home.toFixed(2)}
        </motion.div>
      )}
      {mw?.draw && (
        <motion.div style={{ padding: '6px 14px', borderRadius: 10, background: 'linear-gradient(135deg, #f59e0b, #d97706)', fontWeight: 700, fontSize: '.9rem', cursor: 'default' }} whileHover={{ scale: 1.05 }}>
          X {mw.draw.toFixed(2)}
        </motion.div>
      )}
      {mw?.away && (
        <motion.div style={{ padding: '6px 14px', borderRadius: 10, background: 'linear-gradient(135deg, #ef4444, #dc2626)', fontWeight: 700, fontSize: '.9rem', cursor: 'default' }} whileHover={{ scale: 1.05 }}>
          {mw.away.toFixed(2)}
        </motion.div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════
// PROB BAR
// ══════════════════════════════════════════
function ProbBar({ label, value, delay = 0 }) {
  const display = cap(value);
  const colorClass = getProbColor(display);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '.875rem', marginBottom: 4 }}>
        <span style={{  color: 'white' }}>{label}</span>
        <motion.span
          style={{ fontWeight: 700, color: display >= 70 ? '#4ade80' : display >= 50 ? '#fbbf24' : '#f87171' }}
          animate={{ scale: [1, 1.05, 1] }}
          transition={{ duration: 2, repeat: Infinity, delay: delay % 1 }}
        >
          {display}%
        </motion.span>
      </div>
      <div className="ap2-prob-track">
        <motion.div
          className={`ap2-prob-fill ${colorClass}`}
          initial={{ width: 0 }}
          animate={{ width: `${display}%` }}
          transition={{ delay, duration: .8, ease: 'easeOut' }}
        />
      </div>
    </div>
  );
}

// ══════════════════════════════════════════
// STAT CARD
// ══════════════════════════════════════════
function StatCard({ title, items, accentColor, borderColor }) {
  return (
    <motion.div
      className="ap2-stat-inner"
      style={{ background: accentColor || 'rgba(255,255,255,.05)', border: `1px solid ${borderColor || 'rgba(255,255,255,.1)'}` }}
      whileHover={{ scale: 1.02 }}
    >
      <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 14 }}>{title}</div>
      {items.map((item, i) => (
        <div key={i} className="ap2-stat-row">
          <span style={{  color: 'white', fontSize: '.875rem' }}>{item.label}</span>
          <strong style={{ fontSize: '1.1rem', color: item.color || '#f1f5f9' }}>{item.value}</strong>
        </div>
      ))}
    </motion.div>
  );
}

// ══════════════════════════════════════════
// LAST 5 TABLE
// ══════════════════════════════════════════
function Last5Table({ team, logo, teamId, form, lastFive, accentColor = '#00d4ff' }) {
  if (!form || !form.results.length) return <div style={{  color: 'white', padding: 16 }}>Sin datos</div>;

  const hasEnriched = lastFive && lastFive.length > 0 && lastFive[0]?._enriched;

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <TeamLogo src={logo} name={team} size={28} />
          <span style={{ fontWeight: 700, fontSize: '1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{team}</span>
        </div>
        <div style={{ padding: '4px 12px', borderRadius: 999, background: `linear-gradient(to right, ${accentColor}22, ${accentColor}11)`, border: `1px solid ${accentColor}44`, fontSize: '.78rem', fontWeight: 600 }}>
          {form.points}/{form.maxPoints} pts
        </div>
      </div>

      {/* Form pills */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {form.results.map((r, i) => (
          <motion.div
            key={i}
            className={`ap2-rdot ${r.result.toLowerCase()}`}
            title={`${r.result} vs ${r.opponent}`}
            initial={{ scale: 0, rotate: -180 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ delay: .1 + i * .04 }}
            whileHover={{ scale: 1.12, rotate: 4 }}
          >
            {r.result}
          </motion.div>
        ))}
      </div>

      {/* Match rows */}
      {hasEnriched ? (
        lastFive.map((match, i) => {
          const e = match._enriched;
          return (
            <motion.div
              key={i}
              className="ap2-match-row"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: .15 + i * .04 }}
              whileHover={{ x: 4 }}
            >
              <div className={`ap2-rdot ${e.result.toLowerCase()}`} style={{ width: 30, height: 30, fontSize: '.75rem' }}>{e.result}</div>
              <span style={{ minWidth: 48, fontWeight: 700 }}>{e.score}</span>
              <span style={{ fontSize: '.78rem',  color: 'white' }}>{e.isHome ? 'L' : 'V'}</span>
              {e.opponentLogo && <img src={e.opponentLogo} alt="" style={{ width: 18, height: 18, objectFit: 'contain' }} />}
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.opponentName}</span>
              {e.corners && <span style={{ fontSize: '.72rem',  color: 'white' }}>⛳{e.corners.total}</span>}
              {e.yellowCards?.total > 0 && <span style={{ fontSize: '.72rem' }}>🟨{e.yellowCards.total}</span>}
              {e.redCards?.total > 0 && <span style={{ fontSize: '.72rem' }}>🟥{e.redCards.total}</span>}
            </motion.div>
          );
        })
      ) : (
        form.results.map((r, i) => (
          <motion.div
            key={i}
            className="ap2-match-row"
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: .15 + i * .04 }}
            whileHover={{ x: 4 }}
          >
            <div className={`ap2-rdot ${r.result.toLowerCase()}`} style={{ width: 30, height: 30, fontSize: '.75rem' }}>{r.result}</div>
            <span style={{ minWidth: 48, fontWeight: 700 }}>{r.goalsFor}-{r.goalsAgainst}</span>
            <span style={{ fontSize: '.78rem',  color: 'white' }}>{r.wasHome ? 'L' : 'V'}</span>
            {r.opponentLogo && <img src={r.opponentLogo} alt="" style={{ width: 18, height: 18, objectFit: 'contain' }} />}
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.opponent}</span>
          </motion.div>
        ))
      )}
    </motion.div>
  );
}

// ══════════════════════════════════════════
// H2H SECTION
// ══════════════════════════════════════════
function H2HSection({ h2h, homeTeam, awayTeam, homeId, summary }) {
  if (!h2h || h2h.length === 0) return <div style={{  color: 'white', padding: 16 }}>Sin historial H2H</div>;

  return (
    <div>
      <div className="ap2-h2h-grid">
        {[
          { value: summary.homeWins, label: homeTeam, bg: 'linear-gradient(135deg, rgba(0,212,255,.2), rgba(59,130,246,.2))', border: 'rgba(0,212,255,.3)' },
          { value: summary.draws, label: 'Empates', bg: 'linear-gradient(135deg, rgba(245,158,11,.2), rgba(249,115,22,.2))', border: 'rgba(245,158,11,.3)' },
          { value: summary.awayWins, label: awayTeam, bg: 'linear-gradient(135deg, rgba(236,72,153,.2), rgba(168,85,247,.2))', border: 'rgba(236,72,153,.3)' },
        ].map((item, i) => (
          <motion.div
            key={i}
            className="ap2-h2h-stat"
            style={{ background: item.bg, border: `1px solid ${item.border}` }}
            whileHover={{ scale: 1.05 }}
            animate={i === 0 ? { boxShadow: ['0 0 10px rgba(0,212,255,.2)', '0 0 20px rgba(0,212,255,.4)', '0 0 10px rgba(0,212,255,.2)'] } : {}}
            transition={{ duration: 2, repeat: Infinity }}
          >
            <div className="ap2-h2h-num">{item.value}</div>
            <div className="ap2-h2h-label" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</div>
          </motion.div>
        ))}
      </div>

      {h2h.map((f, i) => {
        const hg = f.goals?.home ?? 0;
        const ag = f.goals?.away ?? 0;
        const date = f.fixture?.date ? fmtShortDate(f.fixture.date) : '';
        const fHomeId = f.teams?.home?.id;
        let winnerColor = 'rgba(255,255,255,.05)';
        if (hg > ag) winnerColor = fHomeId === homeId ? 'rgba(0,212,255,.08)' : 'rgba(236,72,153,.08)';
        else if (ag > hg) winnerColor = fHomeId === homeId ? 'rgba(236,72,153,.08)' : 'rgba(0,212,255,.08)';

        const stats = f._stats || {};
        return (
          <motion.div
            key={i}
            className="ap2-match-row"
            style={{ background: winnerColor, flexWrap: 'wrap', gap: 8 }}
            initial={{ opacity: 0, x: -16 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: .05 + i * .04 }}
            whileHover={{ x: 4 }}
          >
            <span style={{ fontSize: '.75rem',  color: 'white', minWidth: 56 }}>{date}</span>
            <span style={{ flex: 1, textAlign: 'right', fontSize: '.875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.teams?.home?.name}</span>
            <motion.span
              style={{ padding: '4px 12px', borderRadius: 8, background: 'rgba(0,212,255,.15)', border: '1px solid rgba(0,212,255,.3)', fontWeight: 700, minWidth: 70, textAlign: 'center' }}
              whileHover={{ scale: 1.05 }}
            >
              {hg} - {ag}
            </motion.span>
            <span style={{ flex: 1, fontSize: '.875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.teams?.away?.name}</span>
            {stats.corners && <span style={{ fontSize: '.72rem',  color: 'white' }}>⛳{stats.corners.total}</span>}
            {stats.yellowCards?.total > 0 && <span style={{ fontSize: '.72rem' }}>🟨{stats.yellowCards.total}</span>}
            {stats.redCards?.total > 0 && <span style={{ fontSize: '.72rem' }}>🟥{stats.redCards.total}</span>}
          </motion.div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════
// BAJAS SECTION
// ══════════════════════════════════════════
function BajasSection({ filteredInjuries, allInjuries, homeTeam, awayTeam, onRefresh, refreshing }) {
  const hasInjuryData = allInjuries && allInjuries.length > 0;
  const filtered = filteredInjuries || [];

  if (!hasInjuryData) {
    return (
      <div style={{ textAlign: 'center', padding: '24px 16px' }}>
        <p style={{  color: 'white', marginBottom: 16 }}>Sin bajas confirmadas aún</p>
        <motion.button
          onClick={onRefresh}
          disabled={refreshing}
          style={{ padding: '10px 24px', borderRadius: 12, background: 'linear-gradient(to right, rgba(239,68,68,.3), rgba(249,115,22,.3))', border: '1px solid rgba(239,68,68,.4)', color: 'white', fontWeight: 700, cursor: refreshing ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: refreshing ? .6 : 1 }}
          whileHover={!refreshing ? { scale: 1.05 } : {}}
          whileTap={{ scale: .95 }}
        >
          {refreshing ? 'Actualizando…' : 'Actualizar bajas'}
        </motion.button>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '20px 16px' }}>
        <div style={{ padding: '12px 16px', borderRadius: 12, background: 'rgba(34,197,94,.15)', border: '1px solid rgba(34,197,94,.3)', color: '#4ade80', fontWeight: 600, marginBottom: 16, display: 'inline-block' }}>
          ✅ Once titular sin bajas confirmadas
        </div>
        <br />
        <motion.button
          onClick={onRefresh}
          disabled={refreshing}
          style={{ padding: '8px 20px', borderRadius: 10, background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.15)',  color: 'white', cursor: refreshing ? 'not-allowed' : 'pointer', fontFamily: 'inherit', marginTop: 8 }}
          whileHover={!refreshing ? { scale: 1.03 } : {}}
        >
          {refreshing ? 'Actualizando…' : 'Actualizar bajas'}
        </motion.button>
      </div>
    );
  }

  return (
    <div>
      <motion.div
        style={{ padding: '10px 14px', borderRadius: 12, background: 'rgba(239,68,68,.2)', border: '1px solid rgba(239,68,68,.4)', color: '#fca5a5', fontWeight: 600, fontSize: '.875rem', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}
        animate={{ opacity: [.7, 1, .7] }}
        transition={{ duration: 2, repeat: Infinity }}
      >
        <AlertTriangle size={16} />
        {filtered.length} baja{filtered.length > 1 ? 's' : ''} en el once titular
      </motion.div>

      <div className="ap2-injury-grid">
        {filtered.map((inj, i) => (
          <motion.div
            key={i}
            style={{ padding: '14px', borderRadius: 12, background: 'linear-gradient(to right, rgba(239,68,68,.2), rgba(249,115,22,.2))', border: '1px solid rgba(239,68,68,.3)' }}
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: .05 + i * .06 }}
            whileHover={{ scale: 1.02, borderColor: 'rgba(248,113,113,.6)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <TeamLogo src={inj.team?.logo} name={inj.team?.name} size={20} />
              <span style={{ fontSize: '.75rem',  color: 'white' }}>{inj.team?.name}</span>
            </div>
            <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 8 }}>{inj.player?.name}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ padding: '3px 8px', borderRadius: 6, background: 'rgba(239,68,68,.3)', fontSize: '.75rem', display: 'inline-block' }}>{inj.player?.type}</span>
              <span style={{ padding: '3px 8px', borderRadius: 6, background: 'rgba(249,115,22,.25)', fontSize: '.75rem', display: 'inline-block' }}>{inj.player?.reason || 'N/A'}</span>
            </div>
          </motion.div>
        ))}
      </div>

      <motion.button
        onClick={onRefresh}
        disabled={refreshing}
        style={{ marginTop: 16, width: '100%', padding: '10px', borderRadius: 12, background: 'linear-gradient(to right, rgba(239,68,68,.3), rgba(249,115,22,.3))', border: '1px solid rgba(239,68,68,.4)', color: 'white', fontWeight: 700, cursor: refreshing ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: refreshing ? .6 : 1 }}
        whileHover={!refreshing ? { scale: 1.02 } : {}}
        whileTap={{ scale: .98 }}
      >
        {refreshing ? 'Actualizando…' : 'Actualizar bajas'}
      </motion.button>
    </div>
  );
}

// ══════════════════════════════════════════
// PLAYER HIGHLIGHTS
// ══════════════════════════════════════════
function PlayerHighlights({ highlights }) {
  if (!highlights) return <div style={{  color: 'white', padding: 16 }}>Sin datos de jugadores</div>;

  const { shooters, scorers, shotsTotalists, assisters, foulers, bookers } = highlights;
  if (!scorers?.length && !shooters?.length && !shotsTotalists?.length && !assisters?.length && !foulers?.length && !bookers?.length) {
    return <div style={{  color: 'white', padding: 16 }}>Sin jugadores destacados identificados</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {scorers?.length > 0 && (
        <div>
          <div style={{ fontSize: '.85rem',  color: 'white', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Target size={16} style={{ color: '#4ade80' }} />
            ⚽ Goleadores en racha <small style={{  color: 'white' }}>(gol en 5+ de últimos 10)</small>
          </div>
          {scorers.map((pl, i) => (
            <motion.div
              key={i}
              style={{ padding: '18px 20px', borderRadius: 20, background: 'linear-gradient(to right, rgba(34,197,94,.2), rgba(16,185,129,.2))', border: '1px solid rgba(34,197,94,.3)', marginBottom: 12 }}
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: .05 + i * .08 }}
              whileHover={{ scale: 1.02 }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '1.05rem', marginBottom: 2 }}>{pl.name}</div>
                  <div style={{ fontSize: '.78rem',  color: 'white' }}>{pl.teamName}</div>
                </div>
                <motion.div
                  style={{ padding: '8px 16px', borderRadius: 12, background: 'linear-gradient(135deg, #22c55e, #16a34a)', fontWeight: 700, fontSize: '1.3rem' }}
                  animate={{ scale: [1, 1.08, 1], boxShadow: ['0 0 20px rgba(34,197,94,.5)', '0 0 30px rgba(34,197,94,.8)', '0 0 20px rgba(34,197,94,.5)'] }}
                  transition={{ duration: 2, repeat: Infinity }}
                >
                  {pl.totalGoals} goles
                </motion.div>
              </div>
              <div className="ap2-hp-dots">
                {pl.goals.map((g, j) => (
                  <motion.div
                    key={j}
                    className={`ap2-hp-dot ${g > 0 ? 'scored' : 'miss'}`}
                    title={g > 0 ? `${g} gol(es)` : 'Sin gol'}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: .1 + j * .06 }}
                    whileHover={{ scale: 1.06 }}
                  >
                    {g > 0 ? g : '—'}
                  </motion.div>
                ))}
              </div>
            </motion.div>
          ))}
        </div>
      )}

      {shooters?.length > 0 && (
        <div>
          <div style={{ fontSize: '.85rem',  color: 'white', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Crosshair size={16} style={{ color: '#60a5fa' }} />
            🎯 Tiros a puerta <small style={{  color: 'white' }}>(remate al arco en 5+ de últimos 10)</small>
          </div>
          {shooters.map((pl, i) => (
            <motion.div
              key={i}
              style={{ padding: '18px 20px', borderRadius: 20, background: 'linear-gradient(to right, rgba(59,130,246,.2), rgba(0,212,255,.2))', border: '1px solid rgba(59,130,246,.3)', marginBottom: 12 }}
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: .1 + i * .08 }}
              whileHover={{ scale: 1.02 }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '1.05rem', marginBottom: 2 }}>{pl.name}</div>
                  <div style={{ fontSize: '.78rem',  color: 'white' }}>{pl.teamName}</div>
                </div>
                <motion.div
                  style={{ padding: '8px 14px', borderRadius: 12, background: 'linear-gradient(135deg, #3b82f6, #00d4ff)', fontWeight: 700, fontSize: '1.1rem' }}
                  animate={{ boxShadow: ['0 0 15px rgba(59,130,246,.5)', '0 0 25px rgba(59,130,246,.8)', '0 0 15px rgba(59,130,246,.5)'] }}
                  transition={{ duration: 2, repeat: Infinity, delay: i * .3 }}
                >
                  {pl.totalShots} remates
                </motion.div>
              </div>
              <div className="ap2-hp-dots">
                {pl.shotsOnGoal.map((s, j) => (
                  <motion.div
                    key={j}
                    className={`ap2-hp-dot ${s > 0 ? 'scored' : 'miss'}`}
                    style={s > 0 ? { background: 'rgba(59,130,246,.3)', color: '#60a5fa' } : undefined}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: .12 + j * .06 }}
                    whileHover={{ scale: 1.06 }}
                  >
                    {s > 0 ? s : '—'}
                  </motion.div>
                ))}
              </div>
            </motion.div>
          ))}
        </div>
      )}

      {/* ── Tiros totales (a puerta + fuera + bloqueados) ── */}
      {shotsTotalists?.length > 0 && (
        <PlayerGroupList
          title="💥 Tiros totales"
          hint="(a puerta + fuera + bloqueados, ≥2 en 5+ de últimos 10)"
          players={shotsTotalists}
          metric="shotsTotal"
          totalKey="totalShotsAll"
          unit="tiros totales"
          accentBg="linear-gradient(to right, rgba(96,165,250,.2), rgba(34,211,238,.15))"
          accentBorder="rgba(96,165,250,.3)"
          chipBg="linear-gradient(135deg, #60a5fa, #22d3ee)"
          dotColor="#60a5fa"
        />
      )}

      {/* ── Asistentes ── */}
      {assisters?.length > 0 && (
        <PlayerGroupList
          title="🅰️ Asistentes"
          hint="(asistencia en 5+ de últimos 10)"
          players={assisters}
          metric="assists"
          totalKey="totalAssists"
          unit="asistencias"
          accentBg="linear-gradient(to right, rgba(167,139,250,.2), rgba(192,132,252,.15))"
          accentBorder="rgba(167,139,250,.3)"
          chipBg="linear-gradient(135deg, #a78bfa, #c084fc)"
          dotColor="#a78bfa"
        />
      )}

      {/* ── Faltas frecuentes ── */}
      {foulers?.length > 0 && (
        <PlayerGroupList
          title="⚠️ Faltas frecuentes"
          hint="(falta cometida en 5+ de últimos 10)"
          players={foulers}
          metric="fouls"
          totalKey="totalFouls"
          unit="faltas"
          accentBg="linear-gradient(to right, rgba(245,158,11,.2), rgba(251,146,60,.15))"
          accentBorder="rgba(245,158,11,.3)"
          chipBg="linear-gradient(135deg, #f59e0b, #fb923c)"
          dotColor="#f59e0b"
        />
      )}

      {/* ── Tarjetas frecuentes ── */}
      {bookers?.length > 0 && (
        <PlayerGroupList
          title="🟨 Tarjetas frecuentes"
          hint="(amarilla en 5+ de últimos 10)"
          players={bookers}
          metric="yellows"
          totalKey="totalYellows"
          unit="amarillas"
          accentBg="linear-gradient(to right, rgba(250,204,21,.2), rgba(252,211,77,.15))"
          accentBorder="rgba(250,204,21,.3)"
          chipBg="linear-gradient(135deg, #facc15, #fcd34d)"
          dotColor="#facc15"
        />
      )}
    </div>
  );
}

// Sub-componente reutilizable para grupos de jugadores (shotsTotalists,
// assisters, foulers, bookers). Sigue el mismo patron visual que los
// bloques inline de scorers/shooters de arriba — mas compacto en codigo
// y consistente en estilo.
function PlayerGroupList({ title, hint, players, metric, totalKey, unit, accentBg, accentBorder, chipBg, dotColor }) {
  return (
    <div>
      <div style={{ fontSize: '.85rem', color: 'white', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span>{title}</span>
        <small style={{ color: 'white' }}>{hint}</small>
      </div>
      {players.map((pl, i) => {
        const hist = pl[metric] || [];
        const total = pl[totalKey] || 0;
        return (
          <motion.div
            key={i}
            style={{ padding: '18px 20px', borderRadius: 20, background: accentBg, border: `1px solid ${accentBorder}`, marginBottom: 12 }}
            initial={{ opacity: 0, x: -16 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: .1 + i * .08 }}
            whileHover={{ scale: 1.02 }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12, gap: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: '1.05rem', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pl.name}</div>
                <div style={{ fontSize: '.78rem', color: 'white', opacity: .8 }}>{pl.teamName}</div>
              </div>
              <div style={{ padding: '8px 14px', borderRadius: 12, background: chipBg, fontWeight: 700, fontSize: '1.1rem', whiteSpace: 'nowrap' }}>
                {total} {unit}
              </div>
            </div>
            <div className="ap2-hp-dots">
              {hist.map((n, j) => (
                <div
                  key={j}
                  className={`ap2-hp-dot ${n > 0 ? 'scored' : 'miss'}`}
                  style={n > 0 ? { background: `${dotColor}30`, color: dotColor } : undefined}
                  title={n > 0 ? `${n}` : 'Sin registro'}
                >
                  {n > 0 ? n : '—'}
                </div>
              ))}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════
// PER-TEAM SECTION
// ══════════════════════════════════════════
function PerTeamSection({ perTeam, homeTeam, awayTeam, homeLogo, awayLogo }) {
  const thresholdLabels = {
    goals: { over05: '+0.5', over15: '+1.5', over25: '+2.5' },
    cards: { over05: '+0.5', over15: '+1.5', over25: '+2.5', over35: '+3.5' },
    corners: { over05: '+0.5', over15: '+1.5', over25: '+2.5', over35: '+3.5', over45: '+4.5', over55: '+5.5' },
  };
  const categoryLabels = { goals: 'Goles', cards: 'Tarjetas', corners: 'Corners' };
  const categoryColors = { goals: '#4ade80', cards: '#fbbf24', corners: '#60a5fa' };
  const categories = ['goals', 'cards', 'corners'];

  function renderTeamColumn(teamData, teamName, teamLogo, accentBg, accentBorder) {
    return (
      <motion.div
        className="ap2-inner"
        style={{ background: accentBg, border: `1px solid ${accentBorder}` }}
        whileHover={{ scale: 1.01 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <TeamLogo src={teamLogo} name={teamName} size={26} />
          <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{teamName}</span>
        </div>
        {categories.map(cat => {
          const catData = teamData?.[cat];
          if (!catData) return null;
          const entries = Object.entries(catData)
            .filter(([, prob]) => prob >= 50)
            .map(([key, prob]) => ({ label: thresholdLabels[cat]?.[key] || key, prob }));
          if (entries.length === 0) return null;
          return (
            <div key={cat} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: '.78rem', fontWeight: 700, color: categoryColors[cat], textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>{categoryLabels[cat]}</div>
              {entries.map((e, i) => <ProbBar key={i} label={e.label} value={e.prob} />)}
            </div>
          );
        })}
      </motion.div>
    );
  }

  return (
    <div className="ap2-perteam-grid">
      {renderTeamColumn(perTeam.home, homeTeam, homeLogo, 'rgba(0,212,255,.07)', 'rgba(0,212,255,.2)')}
      {renderTeamColumn(perTeam.away, awayTeam, awayLogo, 'rgba(236,72,153,.07)', 'rgba(236,72,153,.2)')}
    </div>
  );
}

// ══════════════════════════════════════════
// GOAL TIMING SECTION
// ══════════════════════════════════════════
function GoalTimingSection({ goalTiming, homeTeam, awayTeam }) {
  const periods = ['0-15', '15-30', '30-45', '45-60', '60-75', '75-90'];

  const timingClass = (prob) => {
    if (prob >= 70) return 'hi';
    if (prob >= 50) return 'md';
    return 'lo';
  };

  const aggregate = (data, s, e) => {
    if (!data || !data.length) return 0;
    let sum = 0;
    for (let i = s; i <= e; i++) sum += data[i]?.probability || 0;
    return Math.min(95, Math.round(sum / (e - s + 1)));
  };

  const home1H = aggregate(goalTiming.home, 0, 2);
  const home2H = aggregate(goalTiming.home, 3, 5);
  const away1H = aggregate(goalTiming.away, 0, 2);
  const away2H = aggregate(goalTiming.away, 3, 5);
  const comb1H = aggregate(goalTiming.combined, 0, 2);
  const comb2H = aggregate(goalTiming.combined, 3, 5);

  return (
    <div>
      <div className="ap2-timing-overflow">
        <table className="ap2-timing-tbl">
          <thead>
            <tr>
              <th className="ap2-timing-th" style={{ textAlign: 'left' }}></th>
              {periods.map(p => <th key={p} className="ap2-timing-th">{p}&apos;</th>)}
            </tr>
          </thead>
          <tbody>
            {[
              { label: homeTeam, data: goalTiming.home, color: '#67e8f9' },
              { label: awayTeam, data: goalTiming.away, color: '#f9a8d4' },
              { label: 'Combinado', data: goalTiming.combined, color: '#c4b5fd' },
            ].map((row, ri) => (
              <tr key={ri}>
                <td className="ap2-timing-label" style={{ color: row.color }}>{row.label}</td>
                {row.data.map((d, i) => (
                  <td key={i} className={`ap2-timing-cell ${timingClass(d.probability)}`}>
                    {cap(d.probability)}%
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="ap2-timing-halves">
        {[
          { title: '1ra mitad', homeVal: home1H, awayVal: away1H, combVal: comb1H },
          { title: '2da mitad', homeVal: home2H, awayVal: away2H, combVal: comb2H },
        ].map((half, i) => (
          <motion.div
            key={i}
            className="ap2-half-card"
            initial={{ opacity: 0, scale: .95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: .1 + i * .08 }}
            whileHover={{ scale: 1.02 }}
          >
            <div style={{ fontWeight: 700, marginBottom: 12, color: '#c4b5fd' }}>{half.title}</div>
            <div className="ap2-half-row">
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>{homeTeam}</span>
              <span style={{ fontWeight: 700, color: half.homeVal >= 70 ? '#4ade80' : half.homeVal >= 50 ? '#fbbf24' : '#f87171' }}>{half.homeVal}%</span>
            </div>
            <div className="ap2-half-row">
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>{awayTeam}</span>
              <span style={{ fontWeight: 700, color: half.awayVal >= 70 ? '#4ade80' : half.awayVal >= 50 ? '#fbbf24' : '#f87171' }}>{half.awayVal}%</span>
            </div>
            <div className="ap2-half-row combined">
              <span>Combinado</span>
              <motion.span
                style={{ fontWeight: 700, fontSize: '1.1rem', color: '#c4b5fd' }}
                animate={{ scale: [1, 1.08, 1] }}
                transition={{ duration: 2, repeat: Infinity, delay: i * .2 }}
              >
                {half.combVal}%
              </motion.span>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 24, marginTop: 12, fontSize: '.8rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 14, height: 14, borderRadius: 4, background: 'linear-gradient(to right, #00d4ff, #3b82f6)' }} />
          <span style={{  color: 'white' }}>{homeTeam}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 14, height: 14, borderRadius: 4, background: 'linear-gradient(to right, #ec4899, #a855f7)' }} />
          <span style={{  color: 'white' }}>{awayTeam}</span>
        </div>
      </div>
    </div>
  );
}
