'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ChartColumn, Check, CircleSlash, Clock, Plus, Trash2, X } from 'lucide-react';
import DashboardBuffer from '../components/DashboardBuffer';

// Mis apuestas sin dinero: historial de lo abierto, su resultado y la
// analítica por mercado y por equipo. No depende de las recomendaciones.

const SPORTS = { football: 'Fútbol', basketball: 'Baloncesto', baseball: 'Béisbol', american_football: 'Fútbol americano' };
const FAMILIES = {
  ganador: 'Ganador', handicap: 'Hándicap', total: 'Total de goles/puntos', total_equipo: 'Total de un equipo',
  corners: 'Córners', tarjetas: 'Tarjetas', ambos_marcan: 'Ambos marcan', jugador: 'Jugador', otros: 'Otros',
};
const STATUS = { open: 'Abierta', won: 'Ganada', lost: 'Perdida', void: 'Nula', pending: 'Pendiente' };
const money = (value) => (value == null ? '—' : Number(value).toLocaleString('es', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const signed = (value) => (value == null ? '—' : `${value > 0 ? '+' : ''}${money(value)}`);
const percent = (value) => (value == null ? '—' : `${value}%`);
const dateText = (value) => (value ? new Date(value).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

function Tile({ label, value, tone }) {
  return <div className="paper-tile"><small>{label}</small><strong className={tone || ''}>{value}</strong></div>;
}

function ManualBetForm({ onCreated }) {
  const [form, setForm] = useState({ sport: 'football', homeTeam: '', awayTeam: '', name: '', family: 'otros', teamSide: '', odd: '', stake: '10' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (key) => (event) => setForm((previous) => ({ ...previous, [key]: event.target.value }));
  const valid = form.name.trim() && Number(form.odd) > 1 && Number(form.stake) > 0;
  const submit = async (event) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/paper-bets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stake: Number(form.stake), legs: [{
          sport: form.sport, source: 'manual', name: form.name.trim(), family: form.family,
          homeTeam: form.homeTeam.trim() || null, awayTeam: form.awayTeam.trim() || null,
          teamSide: form.teamSide || null, odd: Number(form.odd),
        }] }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'No se pudo registrar');
      setForm((previous) => ({ ...previous, name: '', odd: '' }));
      onCreated();
    } catch (cause) { setError(cause.message); } finally { setBusy(false); }
  };
  return (
    <form className="paper-manual" onSubmit={submit}>
      <p className="paper-hint">Para una línea que la app no recomendó. Su resultado se marca a mano.</p>
      <div className="paper-manual-grid">
        <label>Deporte<select value={form.sport} onChange={set('sport')}>{Object.entries(SPORTS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label>Mercado<select value={form.family} onChange={set('family')}>{Object.entries(FAMILIES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label>Local<input value={form.homeTeam} onChange={set('homeTeam')} maxLength={120} /></label>
        <label>Visitante<input value={form.awayTeam} onChange={set('awayTeam')} maxLength={120} /></label>
        <label className="is-wide">Selección<input value={form.name} onChange={set('name')} maxLength={300} placeholder="Ej.: Más de 9.5 córners" required /></label>
        <label>Trata sobre<select value={form.teamSide} onChange={set('teamSide')}><option value="">El partido</option><option value="home">El local</option><option value="away">El visitante</option></select></label>
        <label>Cuota<input type="number" inputMode="decimal" step="0.01" min="1.01" value={form.odd} onChange={set('odd')} required /></label>
        <label>Importe ficticio<input type="number" inputMode="decimal" step="0.01" min="0.01" value={form.stake} onChange={set('stake')} required /></label>
      </div>
      {error && <p className="paper-opener-error" role="alert">{error}</p>}
      <button type="submit" className="paper-opener-submit" disabled={!valid || busy}><Plus size={16} aria-hidden="true" /> {busy ? 'Registrando…' : 'Registrar apuesta manual'}</button>
    </form>
  );
}

function LegRow({ leg, betId, onChanged }) {
  const [busy, setBusy] = useState(false);
  const mark = async (status) => {
    setBusy(true);
    await fetch(`/api/paper-bets/${betId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ legId: leg.id, status }) }).catch(() => {});
    setBusy(false);
    onChanged();
  };
  const match = leg.home_team && leg.away_team ? `${leg.home_team} vs ${leg.away_team}` : (leg.home_team || leg.away_team || '');
  return (
    <div className={`paper-leg is-${leg.status}`}>
      <div className="paper-leg-main">
        <small>{SPORTS[leg.sport] || leg.sport}{match ? ` · ${match}` : ''}{leg.kickoff ? ` · ${dateText(leg.kickoff)}` : ''}</small>
        <span>{leg.market_name}</span>
        <small>{FAMILIES[leg.market_family] || leg.market_family}{leg.market_period ? ` · ${leg.market_period}` : ''}{leg.source === 'manual' ? ' · manual' : ''}</small>
      </div>
      <div className="paper-leg-side">
        <b title={leg.group_odd ? 'Cuota conjunta de «Crear apuesta» de este partido' : undefined}>{leg.group_odd ? `CA ${Number(leg.group_odd).toFixed(2)}` : Number(leg.odd).toFixed(2)}</b>
        <span className={`paper-badge is-${leg.status}`}>{STATUS[leg.status]}</span>
      </div>
      <div className="paper-leg-actions" aria-label="Marcar resultado">
        {leg.status === 'pending' ? (
          <>
            <button type="button" disabled={busy} onClick={() => mark('won')} title="Marcar ganada" aria-label="Marcar ganada"><Check size={15} aria-hidden="true" /></button>
            <button type="button" disabled={busy} onClick={() => mark('lost')} title="Marcar perdida" aria-label="Marcar perdida"><X size={15} aria-hidden="true" /></button>
            <button type="button" disabled={busy} onClick={() => mark('void')} title="Marcar nula" aria-label="Marcar nula"><CircleSlash size={15} aria-hidden="true" /></button>
          </>
        ) : leg.settled_by === 'manual' ? (
          <button type="button" disabled={busy} onClick={() => mark('pending')} title="Deshacer resultado" aria-label="Deshacer resultado"><Clock size={15} aria-hidden="true" /></button>
        ) : null}
      </div>
    </div>
  );
}

function BetCard({ bet, onChanged }) {
  const remove = async () => {
    if (!window.confirm('¿Borrar esta apuesta del historial?')) return;
    await fetch(`/api/paper-bets/${bet.id}`, { method: 'DELETE' }).catch(() => {});
    onChanged();
  };
  const profit = bet.status === 'open' ? null : Number(bet.payout || 0) - bet.stake;
  return (
    <article className={`paper-bet is-${bet.status}`}>
      <header>
        <span className={`paper-badge is-${bet.status}`}>{STATUS[bet.status]}</span>
        <small>{dateText(bet.placed_at)} · {bet.legs.length === 1 ? 'Simple' : `Combinada x${bet.legs.length}`}</small>
        <button type="button" className="paper-bet-del" onClick={remove} aria-label="Borrar apuesta" title="Borrar apuesta"><Trash2 size={15} aria-hidden="true" /></button>
      </header>
      {bet.legs.map((leg) => <LegRow key={leg.id} leg={leg} betId={bet.id} onChanged={onChanged} />)}
      <footer>
        <span>Importe <b>{money(bet.stake)}</b></span>
        <span>Cuota <b>{bet.total_odd.toFixed(2)}</b></span>
        <span>{bet.status === 'open' ? 'Posible' : 'Retorno'} <b>{money(bet.status === 'open' ? bet.stake * bet.total_odd : bet.payout)}</b></span>
        {profit != null && <span className={profit > 0 ? 'is-up' : profit < 0 ? 'is-down' : ''}>Balance <b>{signed(profit)}</b></span>}
      </footer>
    </article>
  );
}

function Analytics({ analytics }) {
  const [sport, setSport] = useState('all');
  const [family, setFamily] = useState('all');
  const families = (analytics?.families || []).filter((row) => sport === 'all' || row.sport === sport);
  const teams = (analytics?.teams || []).filter((row) => (sport === 'all' || row.sport === sport) && (family === 'all' || row.family === family) && row.won + row.lost > 0);
  if (!(analytics?.families || []).length) return <p className="paper-hint">La analítica aparece cuando haya apuestas registradas.</p>;
  return (
    <>
      <div className="paper-filters">
        <label>Deporte<select value={sport} onChange={(event) => setSport(event.target.value)}><option value="all">Todos</option>{Object.entries(SPORTS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label>Mercado<select value={family} onChange={(event) => setFamily(event.target.value)}><option value="all">Todos</option>{Object.entries(FAMILIES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      </div>
      <h3 className="paper-subtitle">Por mercado</h3>
      <div className="paper-table">
        <div className="paper-tr is-head"><span>Mercado</span><span>Selec.</span><span>Aciertos</span><span>%</span><span>Cuota media</span></div>
        {families.map((row) => (
          <div key={`${row.sport}-${row.family}`} className="paper-tr">
            <span>{FAMILIES[row.family] || row.family}<small>{SPORTS[row.sport] || row.sport}</small></span>
            <b>{row.legs}</b><b>{row.won}/{row.won + row.lost}</b><b>{percent(row.hitRate)}</b><b>{row.averageOdd ?? '—'}</b>
          </div>
        ))}
      </div>
      <h3 className="paper-subtitle">Equipos que más rinden{family !== 'all' ? ` en ${FAMILIES[family].toLowerCase()}` : ''}</h3>
      {teams.length ? (
        <div className="paper-table">
          <div className="paper-tr is-head"><span>Equipo</span><span>Selec.</span><span>Aciertos</span><span>%</span><span>Cuota media</span></div>
          {teams.slice(0, 40).map((row) => (
            <div key={`${row.sport}-${row.family}-${row.team}`} className="paper-tr">
              <span>{row.team}<small>{FAMILIES[row.family] || row.family}</small></span>
              <b>{row.legs}</b><b>{row.won}/{row.won + row.lost}</b><b>{percent(row.hitRate)}</b><b>{row.averageOdd ?? '—'}</b>
            </div>
          ))}
        </div>
      ) : <p className="paper-hint">Todavía no hay selecciones cerradas con este filtro.</p>}
    </>
  );
}

export default function PaperBetsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('bets');
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/paper-bets', { cache: 'no-store' });
      if (!response.ok) throw new Error('No se pudo cargar el historial');
      setData(await response.json());
      setError('');
    } catch (cause) { setError(cause.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const bets = useMemo(() => (data?.bets || []).filter((bet) => filter === 'all' || bet.status === filter), [data, filter]);
  if (!data && !error) return <DashboardBuffer />;
  const summary = data?.summary;

  return (
    <main className="app paper-page">
      <Link href="/dashboard" className="paper-back"><ArrowLeft size={17} aria-hidden="true" /> Volver al panel</Link>
      <h1>Mis apuestas sin dinero</h1>
      {error && <div className="warn">{error}</div>}
      {summary && (
        <div className="paper-tiles">
          <Tile label="Balance" value={signed(summary.profit)} tone={summary.profit > 0 ? 'is-up' : summary.profit < 0 ? 'is-down' : ''} />
          <Tile label="Rentabilidad" value={percent(summary.roi)} tone={summary.roi > 0 ? 'is-up' : summary.roi < 0 ? 'is-down' : ''} />
          <Tile label="Acierto" value={percent(summary.hitRate)} />
          <Tile label="Apostado" value={money(summary.staked)} />
          <Tile label="Ganadas / perdidas" value={`${summary.won} / ${summary.lost}`} />
          <Tile label="Abiertas" value={summary.open} />
        </div>
      )}
      <div className="paper-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'bets'} className={tab === 'bets' ? 'on' : ''} onClick={() => setTab('bets')}>Historial</button>
        <button type="button" role="tab" aria-selected={tab === 'stats'} className={tab === 'stats' ? 'on' : ''} onClick={() => setTab('stats')}><ChartColumn size={15} aria-hidden="true" /> Analítica</button>
        <button type="button" role="tab" aria-selected={tab === 'manual'} className={tab === 'manual' ? 'on' : ''} onClick={() => setTab('manual')}><Plus size={15} aria-hidden="true" /> Manual</button>
      </div>
      {tab === 'bets' && (
        <>
          <div className="paper-filters">
            <label>Estado<select value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="all">Todas</option><option value="open">Abiertas</option><option value="won">Ganadas</option><option value="lost">Perdidas</option><option value="void">Nulas</option>
            </select></label>
          </div>
          {bets.length ? bets.map((bet) => <BetCard key={bet.id} bet={bet} onChanged={load} />)
            : <p className="paper-hint">No hay apuestas{filter === 'all' ? ' todavía. Elige opciones en un partido y ábrelas desde «Tu combinada», en Favoritos.' : ' con este estado.'}</p>}
        </>
      )}
      {tab === 'stats' && <Analytics analytics={data?.analytics} />}
      {tab === 'manual' && <ManualBetForm onCreated={() => { load(); setTab('bets'); }} />}
    </main>
  );
}
