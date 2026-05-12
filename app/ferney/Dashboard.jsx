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
  try {
    return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
};

const fmtDateTime = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'medium' });
  } catch {
    return iso;
  }
};

const todayISO = () => new Date().toISOString().split('T')[0];

function StatCard({ label, value, sub, tone = 'neutral' }) {
  const toneClass = {
    neutral: 'border-zinc-800',
    ok: 'border-emerald-700/50 bg-emerald-950/20',
    warn: 'border-amber-700/50 bg-amber-950/20',
    bad: 'border-red-700/50 bg-red-950/20',
    info: 'border-sky-700/50 bg-sky-950/20',
  }[tone];
  return (
    <div className={`rounded-lg border ${toneClass} bg-zinc-950 p-4`}>
      <div className="text-xs uppercase tracking-wider text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

function ProgressBar({ pct }) {
  const v = Math.max(0, Math.min(100, pct || 0));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
      <div className="h-full bg-emerald-500 transition-all" style={{ width: `${v}%` }} />
    </div>
  );
}

export default function FerneyDashboard({ user }) {
  const [date, setDate] = useState(todayISO());
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [retryBusy, setRetryBusy] = useState(null);

  const fetchOnce = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/ferney?date=${encodeURIComponent(date)}`, {
        cache: 'no-store',
      });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { error: text }; }
      if (!res.ok) {
        setErr(body.error || `HTTP ${res.status}`);
        setStatus(null);
      } else {
        setStatus(body);
        setErr(null);
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    setLoading(true);
    fetchOnce();
  }, [fetchOnce]);

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
        body: JSON.stringify({ queue, jobId }),
      });
      await fetchOnce();
    } finally {
      setRetryBusy(null);
    }
  };

  const queues = status?.queues || [];
  const activeJobs = status?.activeJobs || [];
  const failedJobs = status?.failedJobs || [];
  const analysis = status?.analysis || {};
  const errors = analysis.errors || [];

  const totals = useMemo(() => {
    return queues.reduce(
      (acc, q) => ({
        waiting: acc.waiting + q.waiting,
        active: acc.active + q.active,
        completed: acc.completed + q.completed,
        failed: acc.failed + q.failed,
        delayed: acc.delayed + q.delayed,
      }),
      { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
    );
  }, [queues]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold">/ferney</span>
            <span className="text-xs text-zinc-500">{user?.email}</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-sm"
            />
            <button
              onClick={() => setPaused((p) => !p)}
              className="rounded border border-zinc-800 bg-zinc-900 px-3 py-1 text-sm hover:bg-zinc-800"
              title={paused ? 'Reanudar polling' : 'Pausar polling'}
            >
              {paused ? '▶ Reanudar' : '⏸ Pausar'}
            </button>
            <button
              onClick={fetchOnce}
              className="rounded border border-zinc-800 bg-zinc-900 px-3 py-1 text-sm hover:bg-zinc-800"
            >
              ↻ Refrescar
            </button>
            <span className="text-xs text-zinc-500">
              {loading ? 'cargando…' : status ? `actualizado ${fmtTime(status.ts)}` : ''}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 space-y-6">
        {err && (
          <div className="rounded border border-red-800 bg-red-950/40 p-3 text-sm text-red-200">
            Error: {err}
          </div>
        )}

        {/* === Resumen análisis del día === */}
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Análisis · {date}
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Total partidos" value={analysis.total ?? '—'} />
            <StatCard
              label="Analizados"
              value={analysis.analyzedCount ?? '—'}
              tone="ok"
              sub={analysis.total ? `${Math.round(((analysis.analyzedCount || 0) / analysis.total) * 100)}%` : null}
            />
            <StatCard
              label="Pendientes"
              value={analysis.pendingCount ?? '—'}
              tone={analysis.pendingCount > 0 ? 'warn' : 'neutral'}
            />
            <StatCard
              label="Errores"
              value={errors.length}
              tone={errors.length > 0 ? 'bad' : 'neutral'}
              sub={analysis.completedAt ? `completado ${fmtTime(analysis.completedAt)}` : analysis.startedAt ? `iniciado ${fmtTime(analysis.startedAt)}` : null}
            />
          </div>
        </section>

        {/* === Jobs activos === */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
              Jobs activos ({activeJobs.length})
            </h2>
            <div className="text-xs text-zinc-500">
              Cola: {totals.waiting} en espera · {totals.active} activos · {totals.failed} fallidos · {totals.delayed} retrasados
            </div>
          </div>
          {activeJobs.length === 0 ? (
            <div className="rounded border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-500">
              No hay jobs ejecutándose ahora mismo.
            </div>
          ) : (
            <div className="space-y-2">
              {activeJobs.map((j) => {
                const p = typeof j.progress === 'object' && j.progress !== null ? j.progress : null;
                const pct = p?.total ? Math.round((p.processed / p.total) * 100) : null;
                return (
                  <div key={`${j.queue}-${j.id}`} className="rounded border border-zinc-800 bg-zinc-950 p-3">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs">{j.queue}</span>
                      <span className="font-mono text-xs text-zinc-500">#{j.id}</span>
                      {p?.phase && (
                        <span className="rounded bg-sky-900/40 px-2 py-0.5 text-xs text-sky-200">{p.phase}</span>
                      )}
                      <span className="ml-auto text-xs text-zinc-400">
                        ⏱ {fmtMs(j.elapsedMs)}{j.etaMs != null ? ` · ETA ${fmtMs(j.etaMs)}` : ''}
                      </span>
                    </div>
                    {p?.total ? (
                      <div className="mt-2">
                        <div className="mb-1 flex items-center justify-between text-xs text-zinc-400">
                          <span>
                            {p.processed}/{p.total}
                            {p.analyzed != null && <span className="ml-2 text-emerald-400">✓ {p.analyzed} nuevos</span>}
                            {p.cached != null && p.cached > 0 && <span className="ml-2 text-zinc-500">⚡ {p.cached} cache</span>}
                            {p.failed != null && p.failed > 0 && <span className="ml-2 text-red-400">✗ {p.failed} fallos</span>}
                          </span>
                          <span className="tabular-nums">{pct}%</span>
                        </div>
                        <ProgressBar pct={pct} />
                      </div>
                    ) : (
                      <div className="mt-2 text-xs text-zinc-500">Sin info de progreso</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* === Colas === */}
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">Colas</h2>
          <div className="overflow-x-auto rounded border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900 text-xs uppercase tracking-wider text-zinc-400">
                <tr>
                  <th className="px-3 py-2 text-left">Cola</th>
                  <th className="px-3 py-2 text-right">Espera</th>
                  <th className="px-3 py-2 text-right">Activos</th>
                  <th className="px-3 py-2 text-right">Completados</th>
                  <th className="px-3 py-2 text-right">Fallidos</th>
                  <th className="px-3 py-2 text-right">Retrasados</th>
                  <th className="px-3 py-2 text-right">Acción</th>
                </tr>
              </thead>
              <tbody>
                {queues.map((q) => (
                  <tr key={q.name} className="border-t border-zinc-800 even:bg-zinc-950 hover:bg-zinc-900/40">
                    <td className="px-3 py-2 font-mono text-xs">{q.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{q.waiting}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${q.active > 0 ? 'text-sky-300' : ''}`}>{q.active}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-400">{q.completed}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${q.failed > 0 ? 'text-red-400' : ''}`}>{q.failed}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{q.delayed}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => onRetry(q.name)}
                        disabled={retryBusy === `${q.name}/new`}
                        className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
                        title="Encolar un job nuevo de esta cola"
                      >
                        ▶ Run
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* === Partidos pendientes === */}
        {analysis.pending && analysis.pending.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
              Pendientes de analizar ({analysis.pending.length})
            </h2>
            <div className="overflow-x-auto rounded border border-zinc-800">
              <table className="w-full text-sm">
                <thead className="bg-zinc-900 text-xs uppercase tracking-wider text-zinc-400">
                  <tr>
                    <th className="px-3 py-2 text-left">Liga</th>
                    <th className="px-3 py-2 text-left">Partido</th>
                    <th className="px-3 py-2 text-left">Kickoff</th>
                    <th className="px-3 py-2 text-right">FID</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.pending.slice(0, 100).map((m) => (
                    <tr key={m.fixtureId} className="border-t border-zinc-800 hover:bg-zinc-900/40">
                      <td className="px-3 py-2 text-xs text-zinc-400">{m.league} · {m.country}</td>
                      <td className="px-3 py-2">{m.homeTeam} <span className="text-zinc-500">vs</span> {m.awayTeam}</td>
                      <td className="px-3 py-2 text-xs tabular-nums">{fmtDateTime(m.kickoff)}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-zinc-500">{m.fixtureId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {analysis.pending.length > 100 && (
                <div className="border-t border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-500">
                  …{analysis.pending.length - 100} más sin mostrar
                </div>
              )}
            </div>
          </section>
        )}

        {/* === Log de errores === */}
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Log de errores · {date} ({errors.length})
          </h2>
          {errors.length === 0 ? (
            <div className="rounded border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-500">
              Sin errores registrados.
            </div>
          ) : (
            <div className="overflow-x-auto rounded border border-zinc-800">
              <table className="w-full text-sm">
                <thead className="bg-zinc-900 text-xs uppercase tracking-wider text-zinc-400">
                  <tr>
                    <th className="px-3 py-2 text-left">Hora</th>
                    <th className="px-3 py-2 text-left">Job</th>
                    <th className="px-3 py-2 text-left">Partido</th>
                    <th className="px-3 py-2 text-left">Liga</th>
                    <th className="px-3 py-2 text-left">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {errors.map((e, i) => (
                    <tr key={`${e.ts}-${i}`} className="border-t border-zinc-800 hover:bg-zinc-900/40">
                      <td className="px-3 py-2 text-xs tabular-nums text-zinc-400">{fmtTime(e.ts)}</td>
                      <td className="px-3 py-2 font-mono text-xs">{e.job}</td>
                      <td className="px-3 py-2">
                        {e.homeTeam && e.awayTeam ? (
                          <span>{e.homeTeam} <span className="text-zinc-500">vs</span> {e.awayTeam}</span>
                        ) : e.fixtureId ? (
                          <span className="font-mono text-xs text-zinc-500">FID {e.fixtureId}</span>
                        ) : (
                          <span className="text-zinc-500">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-400">{e.league || '—'}</td>
                      <td className="px-3 py-2 text-xs text-red-300">{e.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* === BullMQ failed jobs (whole-job failures, not per-fixture) === */}
        {failedJobs.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
              Jobs fallidos ({failedJobs.length})
            </h2>
            <div className="overflow-x-auto rounded border border-zinc-800">
              <table className="w-full text-sm">
                <thead className="bg-zinc-900 text-xs uppercase tracking-wider text-zinc-400">
                  <tr>
                    <th className="px-3 py-2 text-left">Cola</th>
                    <th className="px-3 py-2 text-left">Job</th>
                    <th className="px-3 py-2 text-left">Intentos</th>
                    <th className="px-3 py-2 text-left">Cuándo</th>
                    <th className="px-3 py-2 text-left">Motivo</th>
                    <th className="px-3 py-2 text-right">Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {failedJobs.map((j) => (
                    <tr key={`${j.queue}-${j.id}`} className="border-t border-zinc-800 hover:bg-zinc-900/40">
                      <td className="px-3 py-2 font-mono text-xs">{j.queue}</td>
                      <td className="px-3 py-2 font-mono text-xs text-zinc-500">#{j.id}</td>
                      <td className="px-3 py-2 text-xs tabular-nums">{j.attemptsMade}</td>
                      <td className="px-3 py-2 text-xs tabular-nums text-zinc-400">{fmtDateTime(j.finishedOn ? new Date(j.finishedOn).toISOString() : null)}</td>
                      <td className="px-3 py-2 text-xs text-red-300 max-w-md truncate" title={j.failedReason}>
                        {j.failedReason || '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => onRetry(j.queue, j.id)}
                          disabled={retryBusy === `${j.queue}/${j.id}`}
                          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
                        >
                          ↻ Retry
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <footer className="pb-8 pt-4 text-center text-xs text-zinc-600">
          uptime worker: {status ? fmtMs(status.uptimeSec * 1000) : '—'} · polling cada {POLL_MS / 1000}s
        </footer>
      </main>
    </div>
  );
}
