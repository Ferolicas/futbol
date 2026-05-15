'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

const POLL_MS = 2000;

const fmtMs = (ms) => {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
};

const fmtTime = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return iso; }
};

const fmtDateTime = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'medium' }); }
  catch { return iso; }
};

const todayISO = () => new Date().toISOString().split('T')[0];

// ─────────────────────────────────────────────────────────────────────────────

export default function FerneyDashboard({ user }) {
  const [date, setDate]                   = useState(todayISO());
  const [status, setStatus]               = useState(null);
  const [err, setErr]                     = useState(null);
  const [loading, setLoading]             = useState(true);
  const [paused, setPaused]               = useState(false);
  const [retryBusy, setRetryBusy]         = useState(null);
  const [actionBusy, setActionBusy]       = useState(null);
  const [actionMsg, setActionMsg]         = useState(null);
  const [calibrationResult, setCalibrationResult] = useState(null);
  const [vpsStats, setVpsStats]   = useState(null);
  const [vpsError, setVpsError]   = useState(null);

  const fetchOnce = useCallback(async () => {
    try {
      const res  = await fetch(`/api/admin/ferney?date=${encodeURIComponent(date)}`, { cache: 'no-store' });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { error: text }; }
      if (!res.ok) { setErr(body.error || `HTTP ${res.status}`); setStatus(null); }
      else         { setStatus(body); setErr(null); }
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => { setLoading(true); fetchOnce(); }, [fetchOnce]);
  useEffect(() => {
    if (paused) return;
    const id = setInterval(fetchOnce, POLL_MS);
    return () => clearInterval(id);
  }, [fetchOnce, paused]);

  // VPS stats — polling independiente cada 10s
  useEffect(() => {
    const fetchVps = async () => {
      try {
        const res = await fetch('/api/admin/vps-stats', { cache: 'no-store' });
        const body = await res.json();
        if (!res.ok) { setVpsError(body.error || `HTTP ${res.status}`); return; }
        setVpsStats(body);
        setVpsError(null);
      } catch (e) {
        setVpsError(e.message);
      }
    };
    fetchVps();
    const id = setInterval(fetchVps, 10_000);
    return () => clearInterval(id);
  }, []);

  const onRetry = async (queue, jobId) => {
    setRetryBusy(`${queue}/${jobId || 'new'}`);
    try {
      await fetch('/api/admin/ferney', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry', queue, jobId }),
      });
      await fetchOnce();
    } finally { setRetryBusy(null); }
  };

  const onReanalyze = async () => {
    if (!confirm(`¿Re-analizar TODOS los partidos del ${date}?`)) return;
    setActionBusy('reanalyze'); setActionMsg(null);
    try {
      const res  = await fetch('/api/admin/ferney', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'enqueue', queue: 'futbol-analyze-all-today', payload: { date, force: true } }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setActionMsg({ kind: 'ok', text: `Re-análisis encolado (job #${data.enqueued || data.jobId || '?'}).` });
        await fetchOnce();
      } else {
        setActionMsg({ kind: 'bad', text: `Error: ${data.error || `HTTP ${res.status}`}` });
      }
    } catch (e) {
      setActionMsg({ kind: 'bad', text: `Error: ${e.message}` });
    } finally { setActionBusy(null); }
  };

  const onAnalyzeBaseball = async () => {
    if (!confirm(`¿Analizar TODOS los partidos de baseball del ${date}?`)) return;
    setActionBusy('analyze-baseball'); setActionMsg(null);
    try {
      const res = await fetch('/api/admin/ferney', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'enqueue', queue: 'baseball-analyze', payload: { date } }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setActionMsg({ kind: 'ok', text: `Análisis baseball encolado (job #${data.enqueued || data.jobId || '?'}).` });
        await fetchOnce();
      } else {
        setActionMsg({ kind: 'bad', text: `Error: ${data.error || `HTTP ${res.status}`}` });
      }
    } catch (e) {
      setActionMsg({ kind: 'bad', text: `Error: ${e.message}` });
    } finally { setActionBusy(null); }
  };

  const onCalibrate = async (sport) => {
    if (!confirm(`¿Recalibrar modelo ${sport}?`)) return;
    setActionBusy(`calibrate-${sport}`); setActionMsg(null); setCalibrationResult(null);
    try {
      const res  = await fetch('/api/admin/ferney', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'calibrate', sport }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setCalibrationResult(data);
        setActionMsg({ kind: 'ok', text: `Calibración ${sport} en ${(data.durationMs / 1000).toFixed(1)}s.` });
      } else {
        setActionMsg({ kind: 'bad', text: `Error: ${data.error || `HTTP ${res.status}`}` });
      }
    } catch (e) {
      setActionMsg({ kind: 'bad', text: `Error: ${e.message}` });
    } finally { setActionBusy(null); }
  };

  const queues     = status?.queues     || [];
  const activeJobs = status?.activeJobs || [];
  const failedJobs = status?.failedJobs || [];
  const analysis   = status?.analysis   || {};
  const errors     = analysis.errors    || [];

  const totals = useMemo(() => queues.reduce(
    (acc, q) => ({ waiting: acc.waiting + q.waiting, active: acc.active + q.active, completed: acc.completed + q.completed, failed: acc.failed + q.failed, delayed: acc.delayed + q.delayed }),
    { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }
  ), [queues]);

  const pct = analysis.total ? Math.round(((analysis.analyzedCount || 0) / analysis.total) * 100) : 0;

  return (
    <>
      <style>{`
        .fw-page {
          min-height: 100vh;
          background: var(--bg-0);
          color: var(--t1);
          font-family: 'Inter', -apple-system, sans-serif;
        }

        /* ── header ── */
        .fw-header {
          position: sticky;
          top: 0;
          z-index: 30;
          background: rgba(10,14,23,0.92);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border-bottom: 1px solid var(--brd);
        }
        .fw-header-inner {
          max-width: 1100px;
          margin: 0 auto;
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 14px 24px;
          flex-wrap: wrap;
        }
        .fw-title-group {
          display: flex;
          align-items: center;
          gap: 12px;
          min-width: 0;
        }
        .fw-dot {
          width: 36px; height: 36px;
          border-radius: 10px;
          background: linear-gradient(135deg, #10b981, #059669);
          display: flex; align-items: center; justify-content: center;
          font-size: 16px; flex-shrink: 0;
          box-shadow: 0 0 16px rgba(16,185,129,0.35);
        }
        .fw-title { font-size: 1rem; font-weight: 700; color: var(--t1); }
        .fw-subtitle { font-size: 0.75rem; color: var(--t3); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        .fw-live {
          display: flex; align-items: center; gap: 6px;
          font-size: 0.72rem;
        }
        .fw-live-dot {
          width: 7px; height: 7px; border-radius: 50%;
          background: #10b981;
          box-shadow: 0 0 0 3px rgba(16,185,129,0.2);
          animation: fw-pulse 2s infinite;
        }
        .fw-live-dot.paused { background: var(--t3); box-shadow: none; animation: none; }
        .fw-live-dot.loading { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,0.2); }
        @keyframes fw-pulse {
          0%,100% { box-shadow: 0 0 0 3px rgba(16,185,129,0.2); }
          50%      { box-shadow: 0 0 0 6px rgba(16,185,129,0.05); }
        }

        .fw-controls { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .fw-input-date {
          background: var(--bg-2); border: 1px solid var(--brd);
          color: var(--t1); border-radius: 8px;
          padding: 6px 10px; font-size: 0.8rem;
          outline: none; transition: border-color .2s;
        }
        .fw-input-date:focus { border-color: var(--accent-cyan); }
        .fw-btn {
          background: var(--bg-2); border: 1px solid var(--brd);
          color: var(--t2); border-radius: 8px;
          padding: 6px 14px; font-size: 0.8rem; cursor: pointer;
          transition: background .2s, color .2s, border-color .2s;
          white-space: nowrap;
        }
        .fw-btn:hover { background: var(--bg-3); color: var(--t1); border-color: rgba(255,255,255,0.15); }
        .fw-btn.active { background: rgba(16,185,129,0.12); border-color: rgba(16,185,129,0.4); color: #10b981; }

        /* ── main ── */
        .fw-main {
          max-width: 1100px;
          margin: 0 auto;
          padding: 28px 24px 60px;
          display: flex; flex-direction: column; gap: 28px;
        }

        /* ── error ── */
        .fw-error {
          background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3);
          color: #fca5a5; border-radius: 10px; padding: 12px 16px;
          font-size: 0.85rem; display: flex; align-items: center; gap: 8px;
        }

        /* ── actions bar ── */
        .fw-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
        .fw-action-btn {
          display: flex; align-items: center; gap: 6px;
          border-radius: 10px; padding: 8px 16px; font-size: 0.82rem;
          font-weight: 600; cursor: pointer; border: 1px solid;
          transition: all .2s; white-space: nowrap;
        }
        .fw-action-btn:disabled { opacity: .5; cursor: not-allowed; }
        .fw-action-btn.green {
          background: rgba(16,185,129,0.1); border-color: rgba(16,185,129,0.35); color: #10b981;
        }
        .fw-action-btn.green:hover:not(:disabled) { background: rgba(16,185,129,0.18); }
        .fw-action-btn.cyan {
          background: rgba(34,211,238,0.08); border-color: rgba(34,211,238,0.3); color: #22d3ee;
        }
        .fw-action-btn.cyan:hover:not(:disabled) { background: rgba(34,211,238,0.14); }
        .fw-action-btn.yellow {
          background: rgba(245,158,11,0.08); border-color: rgba(245,158,11,0.3); color: #f59e0b;
        }
        .fw-action-btn.yellow:hover:not(:disabled) { background: rgba(245,158,11,0.14); }
        .fw-action-msg {
          font-size: 0.8rem; padding: 7px 14px; border-radius: 8px; border: 1px solid;
        }
        .fw-action-msg.ok  { background: rgba(16,185,129,0.08); border-color: rgba(16,185,129,0.25); color: #6ee7b7; }
        .fw-action-msg.bad { background: rgba(239,68,68,0.08);  border-color: rgba(239,68,68,0.25);  color: #fca5a5; }

        /* ── kpi grid ── */
        .fw-kpi-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 14px;
        }
        @media (max-width: 700px) { .fw-kpi-grid { grid-template-columns: repeat(2, 1fr); } }
        .fw-kpi-card {
          background: var(--bg-2);
          border: 1px solid var(--brd);
          border-radius: 14px;
          padding: 18px 20px;
          position: relative;
          overflow: hidden;
          box-shadow: var(--card-shadow);
          transition: transform .15s, box-shadow .15s;
        }
        .fw-kpi-card:hover { transform: translateY(-1px); box-shadow: var(--card-shadow-hover); }
        .fw-kpi-accent {
          position: absolute; top: 0; left: 0; right: 0; height: 2px;
        }
        .fw-kpi-label {
          font-size: 0.7rem; font-weight: 600; letter-spacing: .06em;
          text-transform: uppercase; color: var(--t3); margin-bottom: 10px;
        }
        .fw-kpi-value {
          font-size: 2.2rem; font-weight: 800; line-height: 1;
          letter-spacing: -0.02em; margin-bottom: 6px;
        }
        .fw-kpi-sub { font-size: 0.75rem; color: var(--t3); }

        /* ── progress ── */
        .fw-progress-wrap { display: flex; flex-direction: column; gap: 8px; }
        .fw-progress-head { display: flex; justify-content: space-between; align-items: center; }
        .fw-progress-label { font-size: 0.8rem; color: var(--t3); }
        .fw-progress-pct { font-size: 0.85rem; font-weight: 700; }
        .fw-progress-bar {
          height: 6px; border-radius: 99px;
          background: var(--bg-3); overflow: hidden;
        }
        .fw-progress-fill {
          height: 100%; border-radius: 99px;
          transition: width .5s ease;
        }

        /* ── section ── */
        .fw-section { display: flex; flex-direction: column; gap: 12px; }
        .fw-section-head {
          display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
        }
        .fw-section-title {
          font-size: 0.9rem; font-weight: 700; color: var(--t1);
          display: flex; align-items: center; gap: 8px;
        }
        .fw-section-badge {
          display: inline-flex; align-items: center;
          font-size: 0.7rem; font-weight: 600;
          padding: 2px 8px; border-radius: 99px;
          background: var(--bg-3); color: var(--t2); border: 1px solid var(--brd);
        }
        .fw-section-meta { font-size: 0.75rem; color: var(--t3); }

        /* ── table ── */
        .fw-table-wrap {
          background: var(--bg-2); border: 1px solid var(--brd);
          border-radius: 14px; overflow: hidden;
          box-shadow: var(--card-shadow);
        }
        .fw-table { width: 100%; border-collapse: collapse; font-size: 0.83rem; }
        .fw-table thead tr {
          background: var(--bg-1);
          border-bottom: 1px solid var(--brd);
        }
        .fw-table th {
          padding: 10px 16px; text-align: left;
          font-size: 0.68rem; font-weight: 700;
          text-transform: uppercase; letter-spacing: .07em;
          color: var(--t3); white-space: nowrap;
        }
        .fw-table th.r { text-align: right; }
        .fw-table tbody tr { border-bottom: 1px solid rgba(255,255,255,0.035); transition: background .12s; }
        .fw-table tbody tr:last-child { border-bottom: none; }
        .fw-table tbody tr:hover { background: var(--bg-3); }
        .fw-table td { padding: 10px 16px; color: var(--t2); vertical-align: middle; }
        .fw-table td.r { text-align: right; }
        .fw-table td.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; color: var(--accent-cyan); }
        .fw-table td.muted { color: var(--t3); }
        .fw-table tfoot tr { background: var(--bg-1); border-top: 1px solid var(--brd); }
        .fw-table tfoot td { padding: 9px 16px; font-weight: 700; font-size: 0.78rem; color: var(--t2); }
        .fw-table tfoot td.r { text-align: right; }
        .fw-table .fw-empty { text-align: center; color: var(--t3); padding: 28px 16px; }

        /* ── mini badge ── */
        .fw-badge {
          display: inline-flex; align-items: center;
          font-size: 0.7rem; font-weight: 600;
          padding: 2px 8px; border-radius: 99px; border: 1px solid;
          white-space: nowrap;
        }
        .fw-badge.green { background: rgba(16,185,129,0.12); border-color: rgba(16,185,129,0.3); color: #6ee7b7; }
        .fw-badge.cyan  { background: rgba(34,211,238,0.1);  border-color: rgba(34,211,238,0.25); color: #67e8f9; }
        .fw-badge.amber { background: rgba(245,158,11,0.1);  border-color: rgba(245,158,11,0.3); color: #fcd34d; }
        .fw-badge.red   { background: rgba(239,68,68,0.1);   border-color: rgba(239,68,68,0.25); color: #fca5a5; }
        .fw-badge.zinc  { background: var(--bg-3); border-color: var(--brd); color: var(--t3); }
        .fw-badge.blue  { background: rgba(99,102,241,0.1);  border-color: rgba(99,102,241,0.3); color: #a5b4fc; }

        /* ── job cards ── */
        .fw-job-card {
          background: var(--bg-2); border: 1px solid var(--brd);
          border-radius: 14px; padding: 16px 20px;
          box-shadow: var(--card-shadow);
        }
        .fw-job-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
        .fw-job-id { font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; color: var(--t3); }
        .fw-job-time { margin-left: auto; font-size: 0.75rem; color: var(--t3); }
        .fw-job-progress-bar {
          height: 5px; border-radius: 99px; background: var(--bg-3); overflow: hidden; margin-bottom: 6px;
        }
        .fw-job-progress-fill {
          height: 100%; border-radius: 99px; transition: width .5s ease;
          background: linear-gradient(90deg, #6366f1, #22d3ee);
        }
        .fw-job-stats {
          display: flex; flex-wrap: wrap; gap: 12px;
          font-size: 0.75rem; color: var(--t3);
        }
        .fw-job-stat-ok { color: #10b981; }
        .fw-job-stat-cache { color: var(--t3); }
        .fw-job-stat-fail { color: #ef4444; }
        .fw-job-pct { margin-left: auto; font-size: 0.8rem; font-weight: 700; color: var(--t1); }

        /* ── action btn in table ── */
        .fw-run-btn {
          background: var(--bg-3); border: 1px solid var(--brd);
          color: var(--t2); border-radius: 7px;
          padding: 4px 10px; font-size: 0.75rem; cursor: pointer;
          transition: all .15s;
        }
        .fw-run-btn:hover:not(:disabled) { background: var(--bg-4); color: var(--t1); border-color: rgba(255,255,255,0.15); }
        .fw-run-btn:disabled { opacity: .4; cursor: not-allowed; }

        /* ── empty card ── */
        .fw-empty-card {
          background: var(--bg-2); border: 1px solid var(--brd);
          border-radius: 14px; padding: 28px;
          text-align: center; color: var(--t3); font-size: 0.85rem;
          box-shadow: var(--card-shadow);
        }
        .fw-ok-card {
          background: rgba(16,185,129,0.06); border: 1px solid rgba(16,185,129,0.2);
          border-radius: 14px; padding: 16px 20px;
          display: flex; align-items: center; gap: 10px;
          color: #6ee7b7; font-size: 0.85rem;
        }

        /* ── vps stats ── */
        .fw-vps-section {
          background: var(--bg-2); border: 1px solid var(--brd);
          border-radius: 14px; padding: 20px 24px; margin-top: 8px;
        }
        .fw-vps-title {
          font-size: 0.8rem; font-weight: 700; text-transform: uppercase;
          letter-spacing: .08em; color: var(--t3); margin-bottom: 16px;
          display: flex; align-items: center; gap: 8px;
        }
        .fw-vps-dot {
          width: 7px; height: 7px; border-radius: 50%; background: #10b981;
          box-shadow: 0 0 6px #10b981; animation: vpsPulse 2s ease-in-out infinite;
        }
        @keyframes vpsPulse { 0%,100%{opacity:1} 50%{opacity:.35} }
        .fw-vps-grid {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;
        }
        .fw-vps-metric { display: flex; flex-direction: column; gap: 6px; }
        .fw-vps-label {
          font-size: 0.75rem; color: var(--t3); display: flex;
          justify-content: space-between; align-items: baseline;
        }
        .fw-vps-label span:last-child { font-size: 0.82rem; font-weight: 700; color: var(--t1); }
        .fw-vps-bar-track {
          height: 6px; border-radius: 99px;
          background: rgba(255,255,255,0.07); overflow: hidden;
        }
        .fw-vps-bar-fill {
          height: 100%; border-radius: 99px;
          transition: width .6s ease;
        }
        .fw-vps-sub { font-size: 0.72rem; color: var(--t3); }
        .fw-vps-procs {
          display: flex; align-items: center; gap: 10px;
          background: var(--bg-1); border: 1px solid var(--brd);
          border-radius: 10px; padding: 12px 16px; margin-top: 16px;
        }
        .fw-vps-procs-icon { font-size: 1.1rem; }
        .fw-vps-procs-val { font-size: 1.1rem; font-weight: 700; color: var(--t1); }
        .fw-vps-procs-lbl { font-size: 0.78rem; color: var(--t3); }
        .fw-vps-error { color: #fca5a5; font-size: 0.8rem; }

        /* ── footer ── */
        .fw-footer {
          display: flex; justify-content: space-between;
          border-top: 1px solid var(--brd); padding-top: 16px;
          font-size: 0.75rem; color: var(--t3);
        }

        /* ── modal ── */
        .fw-overlay {
          position: fixed; inset: 0; z-index: 50;
          background: rgba(0,0,0,0.75);
          backdrop-filter: blur(6px);
          -webkit-backdrop-filter: blur(6px);
          display: flex; align-items: flex-start; justify-content: center;
          overflow-y: auto; padding: 24px; padding-top: 80px;
        }
        .fw-modal {
          width: 100%; max-width: 900px;
          background: var(--bg-1);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 18px;
          box-shadow: 0 20px 80px rgba(0,0,0,0.6);
          overflow: hidden;
        }
        .fw-modal-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 18px 24px;
          border-bottom: 1px solid var(--brd);
          background: var(--bg-2);
        }
        .fw-modal-title { font-size: 1rem; font-weight: 700; color: var(--t1); }
        .fw-modal-close {
          background: var(--bg-3); border: 1px solid var(--brd);
          color: var(--t2); border-radius: 8px;
          padding: 6px 14px; font-size: 0.8rem; cursor: pointer;
          transition: all .15s;
        }
        .fw-modal-close:hover { background: var(--bg-4); color: var(--t1); }
        .fw-modal-body { padding: 24px; display: flex; flex-direction: column; gap: 20px; }
        .fw-modal-note { font-size: 0.75rem; color: var(--t3); }
      `}</style>

      <div className="fw-page">

        {/* ── Header ── */}
        <header className="fw-header">
          <div className="fw-header-inner">
            <div className="fw-title-group">
              <div className="fw-dot">⚙</div>
              <div>
                <div className="fw-title">/ferney</div>
                <div className="fw-subtitle">{user?.email}</div>
              </div>
            </div>

            <div className="fw-live">
              <span className={`fw-live-dot ${loading ? 'loading' : paused ? 'paused' : ''}`} />
              <span style={{ color: loading ? '#f59e0b' : paused ? 'var(--t3)' : '#10b981' }}>
                {loading ? 'actualizando…' : paused ? 'pausado' : status ? fmtTime(status.ts) : 'en vivo'}
              </span>
            </div>

            <div className="fw-controls">
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="fw-input-date"
              />
              <button onClick={() => setPaused((p) => !p)} className={`fw-btn ${paused ? 'active' : ''}`}>
                {paused ? '▶ Reanudar' : '⏸ Pausar'}
              </button>
              <button onClick={fetchOnce} className="fw-btn" title="Refrescar ahora">↻</button>
            </div>
          </div>
        </header>

        <main className="fw-main">

          {/* Error */}
          {err && <div className="fw-error"><span>⚠</span> {err}</div>}

          {/* ── Acciones ── */}
          <div className="fw-actions">
            <button onClick={onReanalyze} disabled={!!actionBusy} className="fw-action-btn green">
              <span>{actionBusy === 'reanalyze' ? '⏳' : '↻'}</span>
              <span>{actionBusy === 'reanalyze' ? 'Encolando…' : `Re-analizar fútbol ${date}`}</span>
            </button>
            <button onClick={onAnalyzeBaseball} disabled={!!actionBusy} className="fw-action-btn yellow">
              <span>{actionBusy === 'analyze-baseball' ? '⏳' : '⚾'}</span>
              <span>{actionBusy === 'analyze-baseball' ? 'Encolando…' : `Analizar baseball ${date}`}</span>
            </button>
            <button onClick={() => onCalibrate('futbol')} disabled={!!actionBusy} className="fw-action-btn cyan">
              <span>{actionBusy === 'calibrate-futbol' ? '⏳' : '⚙'}</span>
              <span>{actionBusy === 'calibrate-futbol' ? 'Calibrando fútbol…' : 'Recalibrar fútbol'}</span>
            </button>
            <button onClick={() => onCalibrate('baseball')} disabled={!!actionBusy} className="fw-action-btn yellow">
              <span>{actionBusy === 'calibrate-baseball' ? '⏳' : '⚾'}</span>
              <span>{actionBusy === 'calibrate-baseball' ? 'Calibrando baseball…' : 'Recalibrar baseball'}</span>
            </button>
            {actionMsg && (
              <div className={`fw-action-msg ${actionMsg.kind}`}>
                {actionMsg.kind === 'ok' ? '✓' : '✗'} {actionMsg.text}
              </div>
            )}
          </div>

          {/* ── KPIs ── */}
          <div className="fw-kpi-grid">
            <KpiCard
              label="Total partidos" value={analysis.total ?? '—'}
              accent="#64748b" valueColor="var(--t1)"
              sub={null} icon="📅"
            />
            <KpiCard
              label="Analizados" value={analysis.analyzedCount ?? '—'}
              accent="#10b981" valueColor="#10b981"
              sub={analysis.total ? `${pct}% del día` : null} icon="✓"
            />
            <KpiCard
              label="Pendientes" value={analysis.pendingCount ?? '—'}
              accent={(analysis.pendingCount ?? 0) > 0 ? '#f59e0b' : '#64748b'}
              valueColor={(analysis.pendingCount ?? 0) > 0 ? '#f59e0b' : 'var(--t1)'}
              sub={null} icon="⏳"
            />
            <KpiCard
              label="Errores" value={errors.length}
              accent={errors.length > 0 ? '#ef4444' : '#64748b'}
              valueColor={errors.length > 0 ? '#ef4444' : 'var(--t1)'}
              sub={analysis.completedAt
                ? `completado ${fmtTime(analysis.completedAt)}`
                : analysis.startedAt ? `iniciado ${fmtTime(analysis.startedAt)}` : null}
              icon={errors.length > 0 ? '✗' : '✓'}
            />
          </div>

          {/* Progress */}
          {analysis.total > 0 && (
            <div className="fw-progress-wrap">
              <div className="fw-progress-head">
                <span className="fw-progress-label">Progreso del análisis — {date}</span>
                <span className="fw-progress-pct" style={{ color: pct === 100 ? '#10b981' : 'var(--t1)' }}>{pct}%</span>
              </div>
              <div className="fw-progress-bar">
                <div
                  className="fw-progress-fill"
                  style={{
                    width: `${pct}%`,
                    background: pct === 100 ? '#10b981' : pct > 60 ? '#22d3ee' : pct > 30 ? '#f59e0b' : '#ef4444',
                  }}
                />
              </div>
            </div>
          )}

          {/* ── Colas ── */}
          <div className="fw-section">
            <div className="fw-section-head">
              <h2 className="fw-section-title">
                Colas BullMQ
                <span className="fw-section-badge">{queues.length}</span>
              </h2>
              <span className="fw-section-meta">
                {totals.active > 0 && <span style={{ color: '#22d3ee' }}>{totals.active} activos · </span>}
                {totals.waiting} espera · {totals.completed} completados
              </span>
            </div>
            <div className="fw-table-wrap">
              <table className="fw-table">
                <thead>
                  <tr>
                    <th>Cola</th>
                    <th className="r">Espera</th>
                    <th className="r">Activos</th>
                    <th className="r">Completados</th>
                    <th className="r">Fallidos</th>
                    <th className="r">Retrasados</th>
                    <th className="r"></th>
                  </tr>
                </thead>
                <tbody>
                  {queues.length === 0 && (
                    <tr><td colSpan={7} className="fw-empty">Sin datos de colas</td></tr>
                  )}
                  {queues.map((q) => (
                    <tr key={q.name}>
                      <td className="mono">{q.name}</td>
                      <td className="r muted">{q.waiting}</td>
                      <td className="r" style={{ color: q.active > 0 ? '#22d3ee' : 'var(--t3)', fontWeight: q.active > 0 ? 700 : 400 }}>{q.active}</td>
                      <td className="r" style={{ color: '#10b981', fontWeight: 600 }}>{q.completed}</td>
                      <td className="r" style={{ color: q.failed > 0 ? '#ef4444' : 'var(--t3)', fontWeight: q.failed > 0 ? 700 : 400 }}>{q.failed}</td>
                      <td className="r muted">{q.delayed}</td>
                      <td className="r">
                        <button className="fw-run-btn" onClick={() => onRetry(q.name)} disabled={retryBusy === `${q.name}/new`}>
                          ▶ Run
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                {queues.length > 1 && (
                  <tfoot>
                    <tr>
                      <td style={{ color: 'var(--t3)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>Total</td>
                      <td className="r">{totals.waiting}</td>
                      <td className="r" style={{ color: totals.active > 0 ? '#22d3ee' : 'var(--t2)' }}>{totals.active}</td>
                      <td className="r" style={{ color: '#10b981' }}>{totals.completed}</td>
                      <td className="r" style={{ color: totals.failed > 0 ? '#ef4444' : 'var(--t2)' }}>{totals.failed}</td>
                      <td className="r">{totals.delayed}</td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          {/* ── Jobs activos ── */}
          <div className="fw-section">
            <div className="fw-section-head">
              <h2 className="fw-section-title">
                Jobs activos
                <span className="fw-section-badge" style={activeJobs.length > 0 ? { background: 'rgba(34,211,238,0.1)', borderColor: 'rgba(34,211,238,0.3)', color: '#22d3ee' } : {}}>
                  {activeJobs.length}
                </span>
              </h2>
            </div>
            {activeJobs.length === 0 ? (
              <div className="fw-empty-card">No hay jobs ejecutándose ahora mismo.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {activeJobs.map((j) => {
                  const p   = typeof j.progress === 'object' && j.progress !== null ? j.progress : null;
                  const pct = p?.total ? Math.round((p.processed / p.total) * 100) : null;
                  return (
                    <div key={`${j.queue}-${j.id}`} className="fw-job-card">
                      <div className="fw-job-head">
                        <span className="fw-badge blue">{j.queue}</span>
                        {p?.phase && <span className="fw-badge cyan">{p.phase}</span>}
                        <span className="fw-job-id">#{j.id}</span>
                        <span className="fw-job-time">⏱ {fmtMs(j.elapsedMs)}{j.etaMs != null ? ` · ETA ${fmtMs(j.etaMs)}` : ''}</span>
                      </div>
                      {p?.total ? (
                        <>
                          <div className="fw-job-progress-bar">
                            <div className="fw-job-progress-fill" style={{ width: `${pct}%` }} />
                          </div>
                          <div className="fw-job-stats">
                            <span>{p.processed} / {p.total}</span>
                            {p.analyzed != null && <span className="fw-job-stat-ok">✓ {p.analyzed} nuevos</span>}
                            {p.cached  != null && p.cached  > 0 && <span className="fw-job-stat-cache">⚡ {p.cached} cache</span>}
                            {p.failed  != null && p.failed  > 0 && <span className="fw-job-stat-fail">✗ {p.failed}</span>}
                            <span className="fw-job-pct">{pct}%</span>
                          </div>
                        </>
                      ) : (
                        <span style={{ fontSize: '0.78rem', color: 'var(--t3)' }}>Sin datos de progreso</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Pendientes ── */}
          {analysis.pending?.length > 0 && (
            <div className="fw-section">
              <div className="fw-section-head">
                <h2 className="fw-section-title">
                  Pendientes de analizar
                  <span className="fw-section-badge" style={{ background: 'rgba(245,158,11,0.1)', borderColor: 'rgba(245,158,11,0.3)', color: '#fcd34d' }}>
                    {analysis.pending.length}
                  </span>
                </h2>
              </div>
              <div className="fw-table-wrap">
                <table className="fw-table">
                  <thead>
                    <tr>
                      <th>Liga</th>
                      <th>Local</th>
                      <th>Visitante</th>
                      <th>Kickoff</th>
                      <th className="r">FID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.pending.slice(0, 100).map((m) => (
                      <tr key={m.fixtureId}>
                        <td>
                          <span style={{ color: 'var(--t2)' }}>{m.league}</span>
                          <span style={{ color: 'var(--t3)', fontSize: '0.75rem', marginLeft: 6 }}>{m.country}</span>
                        </td>
                        <td>{m.homeTeam}</td>
                        <td className="muted">{m.awayTeam}</td>
                        <td className="muted" style={{ fontSize: '0.78rem' }}>{fmtDateTime(m.kickoff)}</td>
                        <td className="r muted" style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem' }}>{m.fixtureId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {analysis.pending.length > 100 && (
                  <div style={{ padding: '10px 16px', fontSize: '0.78rem', color: 'var(--t3)', borderTop: '1px solid var(--brd)' }}>
                    …{analysis.pending.length - 100} más no mostrados
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Errores ── */}
          <div className="fw-section">
            <div className="fw-section-head">
              <h2 className="fw-section-title">
                Log de errores
                {errors.length > 0 && (
                  <span className="fw-section-badge" style={{ background: 'rgba(239,68,68,0.1)', borderColor: 'rgba(239,68,68,0.3)', color: '#fca5a5' }}>
                    {errors.length}
                  </span>
                )}
              </h2>
              <span className="fw-section-meta">{date}</span>
            </div>
            {errors.length === 0 ? (
              <div className="fw-ok-card">
                <span style={{ fontSize: '1.1rem' }}>✓</span>
                Sin errores registrados para este día.
              </div>
            ) : (
              <div className="fw-table-wrap">
                <table className="fw-table">
                  <thead>
                    <tr>
                      <th>Hora</th>
                      <th>Job</th>
                      <th>Partido</th>
                      <th>Liga</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {errors.map((e, i) => (
                      <tr key={`${e.ts}-${i}`}>
                        <td className="muted" style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{fmtTime(e.ts)}</td>
                        <td className="mono">{e.job}</td>
                        <td>
                          {e.homeTeam && e.awayTeam
                            ? <span>{e.homeTeam} <span style={{ color: 'var(--t3)' }}>vs</span> {e.awayTeam}</span>
                            : e.fixtureId
                              ? <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem', color: 'var(--t3)' }}>FID {e.fixtureId}</span>
                              : <span style={{ color: 'var(--t3)' }}>—</span>
                          }
                        </td>
                        <td className="muted">{e.league || '—'}</td>
                        <td style={{ color: '#fca5a5', fontSize: '0.8rem', maxWidth: 280 }}>
                          <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.error}>{e.error}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Jobs fallidos ── */}
          {failedJobs.length > 0 && (
            <div className="fw-section">
              <div className="fw-section-head">
                <h2 className="fw-section-title">
                  Jobs fallidos
                  <span className="fw-section-badge" style={{ background: 'rgba(239,68,68,0.1)', borderColor: 'rgba(239,68,68,0.3)', color: '#fca5a5' }}>
                    {failedJobs.length}
                  </span>
                </h2>
              </div>
              <div className="fw-table-wrap">
                <table className="fw-table">
                  <thead>
                    <tr>
                      <th>Cola</th>
                      <th>Job ID</th>
                      <th className="r">Intentos</th>
                      <th>Cuándo</th>
                      <th>Motivo</th>
                      <th className="r"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {failedJobs.map((j) => (
                      <tr key={`${j.queue}-${j.id}`}>
                        <td className="mono">{j.queue}</td>
                        <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', color: 'var(--t3)' }}>#{j.id}</td>
                        <td className="r muted">{j.attemptsMade}</td>
                        <td className="muted" style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{fmtDateTime(j.finishedOn ? new Date(j.finishedOn).toISOString() : null)}</td>
                        <td style={{ color: '#fca5a5', fontSize: '0.8rem', maxWidth: 260 }}>
                          <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={j.failedReason}>{j.failedReason || '—'}</span>
                        </td>
                        <td className="r">
                          <button className="fw-run-btn" onClick={() => onRetry(j.queue, j.id)} disabled={retryBusy === `${j.queue}/${j.id}`}>
                            ↻ Retry
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── VPS Stats ── */}
          <VpsStats stats={vpsStats} error={vpsError} />

          {/* Footer */}
          <div className="fw-footer">
            <span>uptime worker: {status ? fmtMs(status.uptimeSec * 1000) : '—'}</span>
            <span>polling cada {POLL_MS / 1000}s</span>
          </div>
        </main>

        {/* ── Modal calibración ── */}
        {calibrationResult && (
          <div className="fw-overlay">
            <div className="fw-modal">
              <div className="fw-modal-header">
                <h3 className="fw-modal-title">Calibración {calibrationResult.sport} — Resultados</h3>
                <button onClick={() => setCalibrationResult(null)} className="fw-modal-close">✕ Cerrar</button>
              </div>
              <div className="fw-modal-body">
                {/* KPIs */}
                <div className="fw-kpi-grid">
                  <KpiCard label="Muestras totales" value={calibrationResult.sampleSize}             accent="#64748b" valueColor="var(--t1)" />
                  <KpiCard label="Mercados antes"   value={calibrationResult.before?.marketsCount ?? '—'} accent="#64748b" valueColor="var(--t1)"
                    sub={calibrationResult.before?.builtAt ? fmtDateTime(calibrationResult.before.builtAt) : 'sin datos previos'} />
                  <KpiCard label="Mercados ahora"   value={calibrationResult.after?.marketsCount ?? '—'}  accent="#10b981" valueColor="#10b981"
                    sub={fmtDateTime(calibrationResult.after?.builtAt)} />
                  <KpiCard label="Duración"         value={`${(calibrationResult.durationMs / 1000).toFixed(1)}s`} accent="#22d3ee" valueColor="#22d3ee" />
                </div>

                {/* Markets table */}
                <div className="fw-table-wrap">
                  <table className="fw-table">
                    <thead>
                      <tr>
                        <th>Mercado</th>
                        <th className="r">Muestras</th>
                        <th>Estado</th>
                        <th className="r">Δ máx</th>
                        <th className="r">Δ medio</th>
                        <th>Mayor cambio</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(calibrationResult.markets || []).map((m) => {
                        const isNew   = m.status === 'calibrated' && !m.beforeKnots;
                        const skipped = m.status !== 'calibrated';
                        const dM      = m.diff?.maxShift;
                        const dA      = m.diff?.meanShift;
                        const big     = m.diff?.biggest;
                        const sign    = (v) => (v > 0 ? '+' : '') + v;
                        return (
                          <tr key={m.key}>
                            <td className="mono">{m.key}</td>
                            <td className="r muted">{m.samples}</td>
                            <td>
                              {skipped
                                ? <span className="fw-badge zinc">{m.status}</span>
                                : isNew
                                  ? <span className="fw-badge cyan">nuevo</span>
                                  : <span className="fw-badge green">recalibrado</span>
                              }
                            </td>
                            <td className="r" style={{ color: dM != null && Math.abs(dM) > 3 ? '#f59e0b' : 'var(--t2)', fontWeight: dM != null && Math.abs(dM) > 3 ? 700 : 400 }}>
                              {dM != null ? `${sign(dM)}pp` : '—'}
                            </td>
                            <td className="r muted">{dA != null ? `${dA}pp` : '—'}</td>
                            <td className="muted" style={{ fontSize: '0.78rem' }}>{big ? `en ${big.x}%: ${big.before}→${big.after}` : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="fw-modal-note">
                  Δ = cambio en puntos porcentuales. Valores &gt;3pp indican un mercado con calibración notablemente diferente.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ── VPS Stats section ─────────────────────────────────────────────────────────

const fmtBytes = (b) => {
  if (!b) return '0 B';
  const gb = b / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = b / 1024 / 1024;
  return `${mb.toFixed(0)} MB`;
};

function VpsBar({ pct, color }) {
  return (
    <div className="fw-vps-bar-track">
      <div className="fw-vps-bar-fill" style={{ width: `${Math.min(100, pct || 0)}%`, background: color }} />
    </div>
  );
}

function VpsStats({ stats, error }) {
  if (error) {
    return (
      <div className="fw-vps-section">
        <div className="fw-vps-title">VPS · Sistema</div>
        <span className="fw-vps-error">⚠ {error}</span>
      </div>
    );
  }
  if (!stats) {
    return (
      <div className="fw-vps-section">
        <div className="fw-vps-title">VPS · Sistema</div>
        <span style={{ color: 'var(--t3)', fontSize: '0.8rem' }}>Cargando…</span>
      </div>
    );
  }

  const ramColor  = stats.ram.percent  > 85 ? '#ef4444' : stats.ram.percent  > 65 ? '#f59e0b' : '#10b981';
  const cpuColor  = stats.cpu.percent  > 85 ? '#ef4444' : stats.cpu.percent  > 65 ? '#f59e0b' : '#22d3ee';
  const diskColor = stats.disk.percent > 85 ? '#ef4444' : stats.disk.percent > 65 ? '#f59e0b' : '#a78bfa';

  return (
    <div className="fw-vps-section">
      <div className="fw-vps-title">
        <span className="fw-vps-dot" />
        VPS · Sistema — polling 10s
      </div>
      <div className="fw-vps-grid">

        {/* RAM */}
        <div className="fw-vps-metric">
          <div className="fw-vps-label">
            <span>RAM</span>
            <span style={{ color: ramColor }}>{stats.ram.percent}%</span>
          </div>
          <VpsBar pct={stats.ram.percent} color={ramColor} />
          <div className="fw-vps-sub">
            {fmtBytes(stats.ram.used)} usada · {fmtBytes(stats.ram.free)} libre · {fmtBytes(stats.ram.total)} total
          </div>
        </div>

        {/* CPU */}
        <div className="fw-vps-metric">
          <div className="fw-vps-label">
            <span>CPU · {stats.cpu.cores} cores</span>
            <span style={{ color: cpuColor }}>{stats.cpu.percent}%</span>
          </div>
          <VpsBar pct={stats.cpu.percent} color={cpuColor} />
          <div className="fw-vps-sub">
            load avg 1m: {stats.cpu.loadAvg1} · 5m: {stats.cpu.loadAvg5} · 15m: {stats.cpu.loadAvg15}
          </div>
        </div>

        {/* Disco */}
        <div className="fw-vps-metric">
          <div className="fw-vps-label">
            <span>Disco /</span>
            <span style={{ color: diskColor }}>{stats.disk.percent}%</span>
          </div>
          <VpsBar pct={stats.disk.percent} color={diskColor} />
          <div className="fw-vps-sub">
            {fmtBytes(stats.disk.used)} usado · {fmtBytes(stats.disk.free)} libre · {fmtBytes(stats.disk.total)} total
          </div>
        </div>

      </div>

      {/* Procesos + uptime */}
      <div className="fw-vps-procs">
        <span className="fw-vps-procs-icon">⚙</span>
        <span className="fw-vps-procs-val">{stats.processes}</span>
        <span className="fw-vps-procs-lbl">procesos activos</span>
        <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--t3)' }}>
          uptime OS: {fmtMs(stats.uptimeSec * 1000)}
        </span>
      </div>
    </div>
  );
}

// ── KPI card helper ───────────────────────────────────────────────────────────

function KpiCard({ label, value, accent, valueColor, sub, icon }) {
  return (
    <div className="fw-kpi-card">
      <div className="fw-kpi-accent" style={{ background: accent }} />
      <div className="fw-kpi-label">{label}</div>
      <div className="fw-kpi-value" style={{ color: valueColor }}>{value ?? '—'}</div>
      {sub && <div className="fw-kpi-sub">{sub}</div>}
    </div>
  );
}
