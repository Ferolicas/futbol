'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Award, CalendarDays, ChevronLeft, ChevronRight, LockKeyhole, Search, ShieldCheck, TrendingUp } from 'lucide-react';
import BrandLogoMedia from '../../components/BrandLogoMedia';
import PredictionSealBadge from '../dashboard/components/PredictionSealBadge';

const SPORTS = {
  football: 'Fútbol', baseball: 'Béisbol', basketball: 'Baloncesto', 'american-football': 'Fútbol americano',
};

function formatDate(value, options = {}) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', ...options });
}

function PerformanceCurve({ points = [] }) {
  const width = 820;
  const height = 250;
  const padX = 42;
  const padTop = 26;
  const padBottom = 42;
  const usableWidth = width - padX * 2;
  const usableHeight = height - padTop - padBottom;
  const safe = points.length > 1 ? points : [{ label: 'Inicio', accuracy: 0 }, { label: 'Ahora', accuracy: points[0]?.accuracy || 0 }];
  const coords = safe.map((point, index) => ({
    ...point,
    x: padX + usableWidth * index / Math.max(1, safe.length - 1),
    y: padTop + usableHeight - Math.max(0, Math.min(100, Number(point.accuracy) || 0)) / 100 * usableHeight,
  }));
  const line = coords.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
  const area = `${line} L ${coords.at(-1).x} ${padTop + usableHeight} L ${coords[0].x} ${padTop + usableHeight} Z`;
  const step = Math.max(1, Math.ceil(coords.length / 5));
  return <div className="public-performance-chart" role="img" aria-label="Evolución del porcentaje de acierto histórico">
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="performanceArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#5ee6b1" stopOpacity=".34" /><stop offset="1" stopColor="#5ee6b1" stopOpacity="0" /></linearGradient></defs>
      {[0, 25, 50, 75, 100].map((value) => <g key={value}><line x1={padX} x2={width - padX} y1={padTop + usableHeight - value / 100 * usableHeight} y2={padTop + usableHeight - value / 100 * usableHeight} /><text x="8" y={padTop + usableHeight - value / 100 * usableHeight + 4}>{value}%</text></g>)}
      <path d={area} className="public-performance-area" />
      <path d={line} className="public-performance-line" />
      {coords.map((point, index) => <g key={`${point.date || 'start'}-${index}`}>
        <circle cx={point.x} cy={point.y} r="4" />
        {(index === 0 || index === coords.length - 1 || index % step === 0) && <text x={point.x} y={height - 12} textAnchor="middle">{point.label}</text>}
      </g>)}
    </svg>
  </div>;
}

function MetricSkeleton() {
  return <div className="public-performance-skeleton"><span /><span /><span /><span /></div>;
}

export default function PublicPerformance() {
  const [filters, setFilters] = useState({ preset: 'all', sport: '', league: '', market: '', team: '', q: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [resultsTab, setResultsTab] = useState('individual');
  const [outcomeFilter, setOutcomeFilter] = useState('');
  const [marketSortAsc, setMarketSortAsc] = useState(false);
  const query = useMemo(() => {
    const params = new URLSearchParams({ preset: filters.preset, page: String(page), pageSize: '12' });
    if (filters.sport) params.set('sport', filters.sport);
    for (const key of ['league', 'market', 'team']) if (filters[key].trim()) params.set(key, filters[key].trim());
    if (filters.q.trim()) params.set('q', filters.q.trim());
    if (outcomeFilter) params.set('outcome', outcomeFilter);
    if (filters.preset === 'custom' && filters.from && filters.to) {
      params.set('from', filters.from);
      params.set('to', filters.to);
    }
    return params.toString();
  }, [filters, page, outcomeFilter]);

  useEffect(() => {
    if (filters.preset === 'custom' && (!filters.from || !filters.to)) {
      setLoading(false);
      setError('Selecciona las dos fechas para consultar el rango personalizado.');
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/public/rendimiento?${query}`, { signal: controller.signal });
        const json = await response.json();
        if (!response.ok) throw new Error(json.error || 'No se pudo cargar el rendimiento');
        setData(json); setError('');
      } catch (requestError) {
        if (requestError.name !== 'AbortError') setError(requestError.message || 'No se pudo cargar el rendimiento');
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 220);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  const updateFilter = (key, value) => { setFilters((current) => ({ ...current, [key]: value })); setPage(1); };
  const updateOutcome = (value) => { setOutcomeFilter(value); setPage(1); };
  const totals = data?.totals;
  const sortedMarkets = useMemo(() => {
    const list = data?.marketPerformance || [];
    return marketSortAsc ? [...list].sort((left, right) => left.accuracy - right.accuracy) : list;
  }, [data?.marketPerformance, marketSortAsc]);
  return <main className="public-performance-page">
    <div className="public-performance-ambient" aria-hidden="true"><span /><span /></div>
    <header className="public-performance-nav">
      <Link href="/" className="public-performance-back"><ArrowLeft size={17} /> Inicio</Link>
      <BrandLogoMedia className="public-performance-logo" animated={false} />
      <Link href="/sign-up" className="public-performance-cta">Crear cuenta</Link>
    </header>

    <section className="public-performance-hero">
      <p className="public-performance-eyebrow"><ShieldCheck size={16} /> Transparencia verificable</p>
      <h1>El rendimiento,<br /><span>abierto para todos.</span></h1>
      <p>Resultados históricos de CF Análisis desde su inicio. Las recomendaciones emitidas bajo el sistema FreeTSA incorporan una prueba externa que cualquiera puede verificar.</p>
      <div className="public-performance-trust">
        <span><LockKeyhole size={16} /> SHA-512 + Merkle</span>
        <span><Award size={16} /> Sello RFC 3161</span>
        <span><CalendarDays size={16} /> Sólo resultados finalizados</span>
      </div>
    </section>

    <section className="public-performance-shell" aria-busy={loading}>
      <div className="public-performance-filters">
        <label><span>Periodo</span><select value={filters.preset} onChange={(event) => updateFilter('preset', event.target.value)}><option value="all">Todos los tiempos</option><option value="day">Hoy</option><option value="week">Últimos 7 días</option><option value="fortnight">Últimos 15 días</option><option value="month">Últimos 30 días</option><option value="quarter">Últimos 90 días</option><option value="semester">Últimos 6 meses</option><option value="year">Último año</option><option value="custom">Rango personalizado</option></select></label>
        <label><span>Deporte</span><select value={filters.sport} onChange={(event) => updateFilter('sport', event.target.value)}><option value="">Todos</option>{Object.entries(SPORTS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label><span>Liga</span><input list="public-performance-leagues" value={filters.league} onChange={(event) => updateFilter('league', event.target.value)} placeholder="Todas" /><datalist id="public-performance-leagues">{(data?.options?.leagues || []).map((item) => <option value={item} key={item} />)}</datalist></label>
        <label><span>Mercado</span><input list="public-performance-markets" value={filters.market} onChange={(event) => updateFilter('market', event.target.value)} placeholder="Todos" /><datalist id="public-performance-markets">{(data?.options?.markets || []).map((item) => <option value={item} key={item} />)}</datalist></label>
        <label><span>Equipo</span><input list="public-performance-teams" value={filters.team} onChange={(event) => updateFilter('team', event.target.value)} placeholder="Todos" /><datalist id="public-performance-teams">{(data?.options?.teams || []).map((item) => <option value={item} key={item} />)}</datalist></label>
        <label className="public-performance-search"><span>Buscar</span><div><Search size={16} /><input value={filters.q} onChange={(event) => updateFilter('q', event.target.value)} maxLength={80} placeholder="Equipo, liga o mercado" /></div></label>
        {filters.preset === 'custom' && <><label><span>Desde</span><input type="date" value={filters.from} min={data?.engineSince || undefined} max={filters.to || undefined} onChange={(event) => updateFilter('from', event.target.value)} /></label><label><span>Hasta</span><input type="date" value={filters.to} min={filters.from || data?.engineSince || undefined} onChange={(event) => updateFilter('to', event.target.value)} /></label></>}
      </div>

      {error && <div className="public-performance-error" role="alert">{error}</div>}
      {!data && loading ? <MetricSkeleton /> : data && <>
        <div className="public-performance-metrics">
          <article className="is-primary"><span>Precisión histórica</span><strong>{totals.accuracy}%</strong><small>{totals.won + totals.lost} recomendaciones decisivas</small></article>
          <article><span>Ganadas</span><strong>{totals.won}</strong><small>Resultados oficiales confirmados</small></article>
          <article><span>Perdidas</span><strong>{totals.lost}</strong><small>También forman parte del registro</small></article>
          <article><span>Desde</span><strong>{formatDate(data.coverage.since, { month: 'short', year: 'numeric', day: undefined })}</strong><small>Histórico disponible de CF Análisis</small></article>
        </div>

        <div className="public-performance-chart-card">
          <header><div><span><TrendingUp size={17} /> Evolución acumulada</span><strong>Porcentaje de acierto sobre ganadas y perdidas</strong></div><small>Actualizado {new Date(data.updatedAt).toLocaleString('es-ES')}</small></header>
          <PerformanceCurve points={data.curve} />
        </div>

        <div className="public-performance-periods">
          <article><span className="is-archive">Archivo histórico</span><h2>{data.periods.archive.accuracy}%</h2><p>{data.periods.archive.total} recomendaciones finalizadas anteriores o sin sello externo.</p><small>No se presentan como selladas retroactivamente.</small></article>
          <article className="is-certified"><span><ShieldCheck size={15} /> Periodo FreeTSA</span><h2>{data.periods.certified.accuracy}%</h2><p>{data.periods.certified.total} recomendaciones finalizadas con sello externo verificable.</p><small>{data.coverage.certifiedSince ? `Certificación visible desde ${formatDate(data.coverage.certifiedSince)}` : 'Las primeras recomendaciones aparecerán aquí al finalizar oficialmente.'}</small></article>
        </div>

        <div className="public-results-tablist" role="tablist" aria-label="Resultados del motor">
          <button type="button" role="tab" id="public-results-tab-individual" aria-selected={resultsTab === 'individual'} aria-controls="public-results-panel-individual" className={resultsTab === 'individual' ? 'is-active' : ''} onClick={() => setResultsTab('individual')}>Opciones ganadoras y perdedoras</button>
          <button type="button" role="tab" id="public-results-tab-markets" aria-selected={resultsTab === 'markets'} aria-controls="public-results-panel-markets" className={resultsTab === 'markets' ? 'is-active' : ''} onClick={() => setResultsTab('markets')}>Mercados ganadores y perdedores</button>
        </div>

        {resultsTab === 'individual' && <section id="public-results-panel-individual" role="tabpanel" aria-labelledby="public-results-tab-individual" className="public-performance-recommendations">
          <header><div><p>Recomendaciones individuales</p><h2>Todas las opciones del motor, ganadas y perdidas</h2></div><span>{data.pagination.totalItems} recomendaciones</span></header>
          <p className="public-performance-disclosure">Incluye el archivo histórico y las recomendaciones con sello FreeTSA. Sólo las marcadas "Sellado externamente" tienen prueba verificable; el resto es archivo interno sin prueba externa.</p>
          <div className="public-performance-outcome-filter" role="group" aria-label="Filtrar por resultado">
            <button type="button" className={outcomeFilter === '' ? 'is-active' : ''} onClick={() => updateOutcome('')}>Todas</button>
            <button type="button" className={outcomeFilter === 'won' ? 'is-active' : ''} onClick={() => updateOutcome('won')}>Ganadas</button>
            <button type="button" className={outcomeFilter === 'lost' ? 'is-active' : ''} onClick={() => updateOutcome('lost')}>Perdidas</button>
          </div>
          {data.recommendations.length ? <div className="public-performance-list">{data.recommendations.map((item, index) => <article key={`${item.seal?.publicId || 'archivo'}-${item.kickoff}-${index}`}>
            <div className="public-performance-pick-head"><span>{SPORTS[item.sport] || item.sport} · {item.league}</span><strong className={`is-${item.outcome}`}>{item.outcome === 'won' ? 'Ganada' : item.outcome === 'lost' ? 'Perdida' : 'Nula'}</strong></div>
            <h3>{item.matchName}</h3><p>{item.marketName}</p>
            <div className="public-performance-pick-data"><span><small>Probabilidad publicada</small><b>{Number(item.probability).toFixed(1)}%</b></span>{item.odd > 0 && <span><small>Cuota registrada</small><b>@{Number(item.odd).toFixed(2)}</b></span>}<span><small>Fecha</small><b>{formatDate(item.kickoff)}</b></span></div>
            {item.certified ? <PredictionSealBadge seal={item.seal} /> : <span className="public-performance-unsealed">Archivo · sin sello externo</span>}
          </article>)}</div> : <div className="public-performance-empty"><ShieldCheck size={30} /><h3>Sin recomendaciones para este filtro</h3><p>Ajusta el periodo o el resultado para ver más recomendaciones.</p></div>}
          {data.pagination.totalPages > 1 && <nav className="public-performance-pagination" aria-label="Paginación de recomendaciones"><button onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={data.pagination.page <= 1}><ChevronLeft size={17} /> Anterior</button><span>Página {data.pagination.page} de {data.pagination.totalPages}</span><button onClick={() => setPage((value) => Math.min(data.pagination.totalPages, value + 1))} disabled={data.pagination.page >= data.pagination.totalPages}>Siguiente <ChevronRight size={17} /></button></nav>}
        </section>}

        {resultsTab === 'markets' && <section id="public-results-panel-markets" role="tabpanel" aria-labelledby="public-results-tab-markets" className="public-market-ranking market-performance-ranking">
          <header><span><small>Mercados ganadores y perdedores</small><strong>Mayor porcentaje de acierto del periodo</strong></span><em>{data.marketPerformance.length} mercados</em></header>
          <div className="public-performance-outcome-filter" role="group" aria-label="Ordenar mercados">
            <button type="button" className={!marketSortAsc ? 'is-active' : ''} onClick={() => setMarketSortAsc(false)}>Más ganadora primero</button>
            <button type="button" className={marketSortAsc ? 'is-active' : ''} onClick={() => setMarketSortAsc(true)}>Menos ganadora primero</button>
          </div>
          {sortedMarkets.length ? <div className="market-performance-table">
            <div className="market-performance-row is-heading"><span>Mercado</span><span>Acierto</span><span>G / P</span><span>Muestra</span></div>
            {sortedMarkets.map((market, index) => <div className={`market-performance-row is-${market.tendency}`} key={`${market.sport}-${market.marketName}`}>
              <span><b>{index + 1}</b><span><strong>{market.marketName}</strong><small>{SPORTS[market.sport] || market.sport}</small></span></span>
              <span><strong>{market.accuracy}%</strong><i><span style={{ width: `${market.accuracy}%` }} /></i></span>
              <span><b className="is-won">{market.won} G</b><b className="is-lost">{market.lost} P</b></span>
              <span>{market.decisive}{market.neutral ? <small> +{market.neutral} nulas</small> : null}</span>
            </div>)}
          </div> : <p className="market-performance-empty">No hay mercados decididos para este periodo.</p>}
        </section>}
      </>}
    </section>
    <footer className="public-performance-footer"><BrandLogoMedia className="public-performance-footer-logo" animated={false} /><p>Transparencia estadística y pruebas independientes. Ninguna estimación garantiza resultados futuros.</p><Link href="/sign-up">Explorar CF Análisis</Link></footer>
  </main>;
}
