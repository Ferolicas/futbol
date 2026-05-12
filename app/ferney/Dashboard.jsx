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

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, tone = 'neutral', icon }) {
  const tones = {
    neutral: { accent: 'bg-zinc-700',     text: 'text-white',       ring: 'ring-zinc-700/30',    icon: 'text-zinc-400' },
    ok:      { accent: 'bg-emerald-500',  text: 'text-emerald-400', ring: 'ring-emerald-500/20', icon: 'text-emerald-400' },
    warn:    { accent: 'bg-amber-500',    text: 'text-amber-400',   ring: 'ring-amber-500/20',   icon: 'text-amber-400' },
    bad:     { accent: 'bg-red-500',      text: 'text-red-400',     ring: 'ring-red-500/20',     icon: 'text-red-400' },
    info:    { accent: 'bg-blue-500',     text: 'text-blue-400',    ring: 'ring-blue-500/20',    icon: 'text-blue-400' },
  };
  const t = tones[tone];
  return (
    <div className={`relative overflow-hidden rounded-xl border border-white/5 bg-white/[0.03] p-5 ring-1 ${t.ring} backdrop-blur-sm`}>
      <div className={`absolute left-0 top-0 h-0.5 w-full ${t.accent} opacity-60`} />
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</p>
          <p className={`mt-2 text-3xl font-bold tabular-nums ${t.text}`}>{value ?? '—'}</p>
          {sub && <p className="mt-1 text-xs text-zinc-600">{sub}</p>}
        </div>
        {icon && <span className={`text-2xl opacity-70 ${t.icon}`}>{icon}</span>}
      </div>
    </div>
  );
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ pct, showLabel = false }) {
  const v = Math.max(0, Math.min(100, pct || 0));
  const gradient =
    v === 100 ? 'from-emerald-500 to-emerald-400'
    : v > 60  ? 'from-blue-600 to-blue-400'
    : v > 30  ? 'from-amber-600 to-amber-400'
    :           'from-red-600 to-red-400';
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${gradient} transition-all duration-500`}
          style={{ width: `${v}%` }}
        />
      </div>
      {showLabel && <span className="w-8 shrink-0 text-right text-xs tabular-nums text-zinc-500">{v}%</span>}
    </div>
  );
}

// ── Badge ─────────────────────────────────────────────────────────────────────

function Badge({ children, color = 'zinc' }) {
  const cm = {
    zinc:    'bg-zinc-800 text-zinc-300 border-zinc-700',
    emerald: 'bg-emerald-900/50 text-emerald-300 border-emerald-800/60',
    sky:     'bg-sky-900/50 text-sky-300 border-sky-800/60',
    amber:   'bg-amber-900/50 text-amber-300 border-amber-800/60',
    red:     'bg-red-900/50 text-red-300 border-red-800/60',
    blue:    'bg-blue-900/50 text-blue-300 border-blue-800/60',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${cm[color]}`}>
      {children}
    </span>
  );
}

// ── Section header ────────────────────────────────────────────────────────────

function Section({ title, right, children }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {right && <div className="text-xs text-zinc-500">{right}</div>}
      </div>
      {children}
    </div>
  );
}

// ── Table shell ───────────────────────────────────────────────────────────────

function Table({ head, children, empty }) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/5 bg-white/[0.02]">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5">
              {head.map((h, i) => (
                <th
                  key={i}
                  className={`px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 ${h.right ? 'text-right' : 'text-left'}`}
                >
                  {h.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.03]">
            {empty ? (
              <tr>
                <td colSpan={head.length} className="px-4 py-6 text-center text-sm text-zinc-600">{empty}</td>
              </tr>
            ) : children}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const TR = ({ children, className = '' }) => (
  <tr className={`transition-colors hover:bg-white/[0.03] ${className}`}>{children}</tr>
);
const TD = ({ children, right = false, mono = false, muted = false, className = '' }) => (
  <td className={`px-4 py-2.5 text-sm ${right ? 'text-right' : ''} ${mono ? 'font-mono text-xs' : ''} ${muted ? 'text-zinc-500' : 'text-zinc-200'} ${className}`}>
    {children}
  </td>
);

// ── Main dashboard ────────────────────────────────────────────────────────────

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
        setActionMsg({ kind: 'ok', text: `Calibración ${sport} completada en ${(data.durationMs / 1000).toFixed(1)}s.` });
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

  const analysisComplete = analysis.total
    ? Math.round(((analysis.analyzedCount || 0) / analysis.total) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">

      {/* ── Header ── */}
      <header className="sticky top-0 z-20 border-b border-white/5 bg-zinc-950/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-4">
          {/* logo + title */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-700 shadow-lg shadow-emerald-900/30">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M2 8a6 6 0 1 1 12 0A6 6 0 0 1 2 8Z" fill="white" fillOpacity=".3"/>
                <path d="M6 8a2 2 0 1 1 4 0A2 2 0 0 1 6 8Z" fill="white"/>
              </svg>
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold leading-none text-white">/ferney</p>
              <p className="mt-0.5 truncate text-[11px] text-zinc-500">{user?.email}</p>
            </div>
          </div>

          {/* live indicator */}
          <div className="hidden items-center gap-1.5 sm:flex">
            {loading ? (
              <span className="text-[11px] text-zinc-600">actualizando…</span>
            ) : (
              <>
                <span className={`relative flex h-2 w-2 ${paused ? '' : 'animate-pulse'}`}>
                  <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${paused ? 'bg-zinc-600' : 'bg-emerald-400 animate-ping'}`} />
                  <span className={`relative inline-flex h-2 w-2 rounded-full ${paused ? 'bg-zinc-600' : 'bg-emerald-500'}`} />
                </span>
                <span className={`text-[11px] ${paused ? 'text-zinc-600' : 'text-emerald-500'}`}>
                  {paused ? 'pausado' : status ? `${fmtTime(status.ts)}` : 'en vivo'}
                </span>
              </>
            )}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-200 outline-none transition focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20"
            />
            <button
              onClick={() => setPaused((p) => !p)}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-white/10"
            >
              {paused ? '▶ Reanudar' : '⏸ Pausar'}
            </button>
            <button
              onClick={fetchOnce}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-white/10"
              title="Refrescar ahora"
            >
              ↻
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-8 px-6 py-8">

        {/* error */}
        {err && (
          <div className="flex items-center gap-3 rounded-xl border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300">
            <span className="text-base">⚠</span> {err}
          </div>
        )}

        {/* ── Acciones ── */}
        <div className="flex flex-wrap items-center gap-2">
          <ActionBtn
            onClick={onReanalyze}
            disabled={!!actionBusy}
            busy={actionBusy === 'reanalyze'}
            busyLabel="Encolando…"
            icon="↻"
            label={`Re-analizar ${date}`}
            variant="emerald"
          />
          <ActionBtn
            onClick={() => onCalibrate('futbol')}
            disabled={!!actionBusy}
            busy={actionBusy === 'calibrate-futbol'}
            busyLabel="Calibrando…"
            icon="⚙"
            label="Recalibrar fútbol"
            variant="sky"
          />
          <ActionBtn
            onClick={() => onCalibrate('baseball')}
            disabled={!!actionBusy}
            busy={actionBusy === 'calibrate-baseball'}
            busyLabel="Calibrando…"
            icon="⚾"
            label="Recalibrar baseball"
            variant="amber"
          />
          {actionMsg && (
            <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
              actionMsg.kind === 'ok'
                ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-300'
                : 'border-red-900/60 bg-red-950/30 text-red-300'
            }`}>
              {actionMsg.kind === 'ok' ? '✓' : '✗'} {actionMsg.text}
            </div>
          )}
        </div>

        {/* ── KPI cards ── */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="Total partidos"  value={analysis.total}            tone="neutral" icon="📅" />
          <StatCard
            label="Analizados"
            value={analysis.analyzedCount}
            tone="ok"
            icon="✓"
            sub={analysis.total ? `${analysisComplete}% del día` : undefined}
          />
          <StatCard
            label="Pendientes"
            value={analysis.pendingCount}
            tone={(analysis.pendingCount ?? 0) > 0 ? 'warn' : 'neutral'}
            icon="⏳"
          />
          <StatCard
            label="Errores"
            value={errors.length}
            tone={errors.length > 0 ? 'bad' : 'neutral'}
            icon={errors.length > 0 ? '✗' : '✓'}
            sub={analysis.completedAt
              ? `completado ${fmtTime(analysis.completedAt)}`
              : analysis.startedAt ? `iniciado ${fmtTime(analysis.startedAt)}` : undefined}
          />
        </div>

        {/* progress */}
        {analysis.total > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-500">Progreso del análisis</span>
              <span className={`font-semibold tabular-nums ${analysisComplete === 100 ? 'text-emerald-400' : 'text-zinc-300'}`}>{analysisComplete}%</span>
            </div>
            <ProgressBar pct={analysisComplete} />
          </div>
        )}

        {/* ── Colas ── */}
        <Section
          title="Colas BullMQ"
          right={`${totals.active} activos · ${totals.waiting} en espera · ${totals.completed} completados`}
        >
          <Table
            head={[
              { label: 'Cola' },
              { label: 'Espera', right: true },
              { label: 'Activos', right: true },
              { label: 'Completados', right: true },
              { label: 'Fallidos', right: true },
              { label: 'Retrasados', right: true },
              { label: '', right: true },
            ]}
            empty={queues.length === 0 ? 'Sin datos de colas' : undefined}
          >
            {queues.map((q) => (
              <TR key={q.name}>
                <TD mono>{q.name}</TD>
                <TD right muted>{q.waiting}</TD>
                <TD right>
                  {q.active > 0
                    ? <span className="font-semibold text-blue-400">{q.active}</span>
                    : <span className="text-zinc-600">0</span>
                  }
                </TD>
                <TD right>
                  <span className="font-medium text-emerald-400">{q.completed}</span>
                </TD>
                <TD right>
                  {q.failed > 0
                    ? <span className="font-semibold text-red-400">{q.failed}</span>
                    : <span className="text-zinc-600">0</span>
                  }
                </TD>
                <TD right muted>{q.delayed}</TD>
                <TD right>
                  <button
                    onClick={() => onRetry(q.name)}
                    disabled={retryBusy === `${q.name}/new`}
                    className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-zinc-300 transition hover:bg-white/10 disabled:opacity-40"
                  >
                    ▶ Run
                  </button>
                </TD>
              </TR>
            ))}
            {queues.length > 1 && (
              <tr className="border-t border-white/10 bg-white/[0.02]">
                <td className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">Total</td>
                <td className="px-4 py-2.5 text-right text-sm font-semibold tabular-nums text-zinc-300">{totals.waiting}</td>
                <td className="px-4 py-2.5 text-right text-sm font-semibold tabular-nums text-blue-400">{totals.active}</td>
                <td className="px-4 py-2.5 text-right text-sm font-semibold tabular-nums text-emerald-400">{totals.completed}</td>
                <td className={`px-4 py-2.5 text-right text-sm font-semibold tabular-nums ${totals.failed > 0 ? 'text-red-400' : 'text-zinc-600'}`}>{totals.failed}</td>
                <td className="px-4 py-2.5 text-right text-sm tabular-nums text-zinc-500">{totals.delayed}</td>
                <td />
              </tr>
            )}
          </Table>
        </Section>

        {/* ── Jobs activos ── */}
        <Section title="Jobs activos" right={activeJobs.length === 0 ? 'ninguno ejecutándose' : `${activeJobs.length} en curso`}>
          {activeJobs.length === 0 ? (
            <div className="rounded-xl border border-white/5 bg-white/[0.02] px-6 py-8 text-center text-sm text-zinc-600">
              No hay jobs ejecutándose ahora mismo.
            </div>
          ) : (
            <div className="space-y-3">
              {activeJobs.map((j) => {
                const p   = typeof j.progress === 'object' && j.progress !== null ? j.progress : null;
                const pct = p?.total ? Math.round((p.processed / p.total) * 100) : null;
                return (
                  <div key={`${j.queue}-${j.id}`} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge color="blue">{j.queue}</Badge>
                      {p?.phase && <Badge color="sky">{p.phase}</Badge>}
                      <span className="font-mono text-xs text-zinc-600">#{j.id}</span>
                      <div className="ml-auto text-xs text-zinc-500">
                        ⏱ {fmtMs(j.elapsedMs)}{j.etaMs != null ? ` · ETA ${fmtMs(j.etaMs)}` : ''}
                      </div>
                    </div>
                    {p?.total ? (
                      <div className="mt-3 space-y-2">
                        <ProgressBar pct={pct} />
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                          <span className="text-zinc-500">{p.processed} / {p.total}</span>
                          {p.analyzed != null && <span className="text-emerald-400">✓ {p.analyzed} nuevos</span>}
                          {p.cached != null && p.cached > 0 && <span className="text-zinc-600">⚡ {p.cached} cache</span>}
                          {p.failed != null && p.failed > 0 && <span className="text-red-400">✗ {p.failed} fallos</span>}
                          <span className="ml-auto font-semibold tabular-nums text-zinc-300">{pct}%</span>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-zinc-600">Sin info de progreso</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        {/* ── Pendientes ── */}
        {analysis.pending?.length > 0 && (
          <Section title="Pendientes de analizar" right={`${analysis.pending.length} partidos`}>
            <Table
              head={[
                { label: 'Liga' },
                { label: 'Local' },
                { label: 'Visitante' },
                { label: 'Kickoff' },
                { label: 'FID', right: true },
              ]}
            >
              {analysis.pending.slice(0, 100).map((m) => (
                <TR key={m.fixtureId}>
                  <TD>
                    <span className="text-zinc-400">{m.league}</span>
                    <span className="ml-1.5 text-xs text-zinc-600">{m.country}</span>
                  </TD>
                  <TD>{m.homeTeam}</TD>
                  <TD muted>{m.awayTeam}</TD>
                  <TD muted>{fmtDateTime(m.kickoff)}</TD>
                  <TD right mono muted>{m.fixtureId}</TD>
                </TR>
              ))}
            </Table>
            {analysis.pending.length > 100 && (
              <p className="text-center text-xs text-zinc-600">…{analysis.pending.length - 100} más no mostrados</p>
            )}
          </Section>
        )}

        {/* ── Errores ── */}
        <Section title="Log de errores" right={`${date}`}>
          {errors.length === 0 ? (
            <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-6 py-5 text-sm text-emerald-500">
              <span className="text-base">✓</span> Sin errores registrados para este día.
            </div>
          ) : (
            <Table
              head={[
                { label: 'Hora' },
                { label: 'Job' },
                { label: 'Partido' },
                { label: 'Liga' },
                { label: 'Error' },
              ]}
            >
              {errors.map((e, i) => (
                <TR key={`${e.ts}-${i}`}>
                  <TD muted mono>{fmtTime(e.ts)}</TD>
                  <TD mono>{e.job}</TD>
                  <TD>
                    {e.homeTeam && e.awayTeam
                      ? <span>{e.homeTeam} <span className="text-zinc-600">vs</span> {e.awayTeam}</span>
                      : e.fixtureId
                        ? <span className="font-mono text-xs text-zinc-500">FID {e.fixtureId}</span>
                        : <span className="text-zinc-600">—</span>
                    }
                  </TD>
                  <TD muted>{e.league || '—'}</TD>
                  <td className="max-w-xs px-4 py-2.5 text-xs text-red-400">
                    <span className="block truncate" title={e.error}>{e.error}</span>
                  </td>
                </TR>
              ))}
            </Table>
          )}
        </Section>

        {/* ── Jobs fallidos ── */}
        {failedJobs.length > 0 && (
          <Section title="Jobs fallidos" right={`${failedJobs.length} en la cola`}>
            <Table
              head={[
                { label: 'Cola' },
                { label: 'Job ID' },
                { label: 'Intentos', right: true },
                { label: 'Cuándo' },
                { label: 'Motivo' },
                { label: '', right: true },
              ]}
            >
              {failedJobs.map((j) => (
                <TR key={`${j.queue}-${j.id}`}>
                  <TD mono>{j.queue}</TD>
                  <TD mono muted>#{j.id}</TD>
                  <TD right muted>{j.attemptsMade}</TD>
                  <TD muted>{fmtDateTime(j.finishedOn ? new Date(j.finishedOn).toISOString() : null)}</TD>
                  <td className="max-w-sm px-4 py-2.5 text-xs text-red-400">
                    <span className="block truncate" title={j.failedReason}>{j.failedReason || '—'}</span>
                  </td>
                  <TD right>
                    <button
                      onClick={() => onRetry(j.queue, j.id)}
                      disabled={retryBusy === `${j.queue}/${j.id}`}
                      className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-zinc-300 transition hover:bg-white/10 disabled:opacity-40"
                    >
                      ↻ Retry
                    </button>
                  </TD>
                </TR>
              ))}
            </Table>
          </Section>
        )}

        {/* footer */}
        <div className="flex items-center justify-between border-t border-white/5 pt-4 text-xs text-zinc-600">
          <span>uptime worker: {status ? fmtMs(status.uptimeSec * 1000) : '—'}</span>
          <span>polling cada {POLL_MS / 1000}s</span>
        </div>
      </main>

      {/* ── Modal calibración ── */}
      {calibrationResult && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-16 backdrop-blur-sm">
          <div className="w-full max-w-4xl rounded-2xl border border-white/10 bg-zinc-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/5 px-6 py-4">
              <h3 className="text-base font-semibold text-white">
                Calibración {calibrationResult.sport} — Resultados
              </h3>
              <button
                onClick={() => setCalibrationResult(null)}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-white/10"
              >
                ✕ Cerrar
              </button>
            </div>

            <div className="space-y-5 p-6">
              {/* KPIs */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard label="Muestras totales"  value={calibrationResult.sampleSize}           tone="neutral" />
                <StatCard label="Mercados antes"    value={calibrationResult.before?.marketsCount} tone="neutral"
                  sub={calibrationResult.before?.builtAt ? fmtDateTime(calibrationResult.before.builtAt) : 'sin datos previos'} />
                <StatCard label="Mercados ahora"    value={calibrationResult.after?.marketsCount}  tone="ok"
                  sub={fmtDateTime(calibrationResult.after?.builtAt)} />
                <StatCard label="Duración"          value={`${(calibrationResult.durationMs / 1000).toFixed(1)}s`} tone="info" />
              </div>

              {/* Markets table */}
              <Table
                head={[
                  { label: 'Mercado' },
                  { label: 'Muestras', right: true },
                  { label: 'Estado' },
                  { label: 'Δ máx', right: true },
                  { label: 'Δ medio', right: true },
                  { label: 'Mayor cambio' },
                ]}
                empty={(calibrationResult.markets || []).length === 0 ? 'Sin datos de mercados' : undefined}
              >
                {(calibrationResult.markets || []).map((m) => {
                  const isNew   = m.status === 'calibrated' && !m.beforeKnots;
                  const skipped = m.status !== 'calibrated';
                  const dM      = m.diff?.maxShift;
                  const dA      = m.diff?.meanShift;
                  const big     = m.diff?.biggest;
                  const sign    = (v) => (v > 0 ? '+' : '') + v;
                  return (
                    <TR key={m.key}>
                      <TD mono>{m.key}</TD>
                      <TD right muted>{m.samples}</TD>
                      <TD>
                        {skipped
                          ? <Badge color="zinc">{m.status}</Badge>
                          : isNew
                            ? <Badge color="sky">nuevo</Badge>
                            : <Badge color="emerald">recalibrado</Badge>
                        }
                      </TD>
                      <TD right className={dM != null && Math.abs(dM) > 3 ? 'font-semibold text-amber-400' : 'text-zinc-400'}>
                        {dM != null ? `${sign(dM)}pp` : '—'}
                      </TD>
                      <TD right muted>{dA != null ? `${dA}pp` : '—'}</TD>
                      <TD muted>{big ? `en ${big.x}%: ${big.before}→${big.after}` : '—'}</TD>
                    </TR>
                  );
                })}
              </Table>
              <p className="text-xs text-zinc-600">
                Δ = cambio en puntos porcentuales sobre la curva calibrada. Valores &gt;3pp indican un mercado con calibración notablemente diferente.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Action button ─────────────────────────────────────────────────────────────

function ActionBtn({ onClick, disabled, busy, busyLabel, icon, label, variant }) {
  const vm = {
    emerald: 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300 hover:bg-emerald-950/70',
    sky:     'border-sky-800/60 bg-sky-950/40 text-sky-300 hover:bg-sky-950/70',
    amber:   'border-amber-800/60 bg-amber-950/40 text-amber-300 hover:bg-amber-950/70',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium transition disabled:opacity-50 ${vm[variant]}`}
    >
      <span>{busy ? '⏳' : icon}</span>
      <span>{busy ? busyLabel : label}</span>
    </button>
  );
}
