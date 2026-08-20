'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowDownToLine,
  BarChart3,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleGauge,
  Filter,
  Search,
  ShieldCheck,
  Trophy,
} from 'lucide-react';
import styles from './MarketReports.module.css';

const SPORT_COPY = Object.freeze({
  futbol: { label: 'Fútbol', accent: 'Fútbol', unit: 'mercados' },
  baseball: { label: 'Béisbol', accent: 'MLB', unit: 'mercados' },
});

function shiftDate(date, amount) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function formatDate(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('es-ES', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

function metric(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${Math.floor((Number(value) + 1e-9) * 100) / 100}%`;
}

function directionRank(value) {
  if (value === 'over') return 0;
  if (value === 'under') return 1;
  return 2;
}

function groupRows(rows) {
  const fixtures = new Map();
  for (const row of rows) {
    const key = String(row.fixture_id || row.partido);
    if (!fixtures.has(key)) fixtures.set(key, {
      id: key, name: row.partido, time: row.hora_bogota, league: row.liga, rows: [],
    });
    fixtures.get(key).rows.push(row);
  }
  return [...fixtures.values()];
}

function MarketLine({ row }) {
  const probability = Math.max(0, Math.min(100, Number(row.probability) || 0));
  return (
    <article className={styles.marketLine}>
      <div className={styles.marketCopy}>
        <span className={`${styles.direction} ${styles[row.direccion] || ''}`}>
          {row.direccion === 'over' ? 'MÁS' : row.direccion === 'under' ? 'MENOS' : row.periodo}
        </span>
        <strong>{row.linea}</strong>
        <small>{row.periodo} · {row.ambito}</small>
      </div>
      <div className={styles.metrics}>
        <span><small>Prob.</small><b>{metric(row.probability)}</b></span>
        <span><small>Fiab.</small><b>{metric(row.reliability)}</b></span>
        {row.odd != null && <span><small>Cuota</small><b>{Number(row.odd).toFixed(2)}</b></span>}
      </div>
      <span className={styles.probabilityBar} style={{ '--market-probability': `${probability}%` }} />
    </article>
  );
}

function MatchCard({ match, expanded, onToggle }) {
  const grouped = useMemo(() => {
    const result = new Map();
    for (const row of match.rows) {
      if (!result.has(row.grupo)) result.set(row.grupo, []);
      result.get(row.grupo).push(row);
    }
    return [...result.entries()].map(([name, rows]) => [name, rows.sort((a, b) => (
      directionRank(a.direccion) - directionRank(b.direccion)
      || Number(a.line_number || 0) - Number(b.line_number || 0)
      || String(a.linea).localeCompare(String(b.linea), 'es')
    ))]);
  }, [match.rows]);
  const best = [...match.rows].sort((a, b) => Number(b.probability || 0) - Number(a.probability || 0))[0];

  return (
    <article className={`${styles.matchCard} ${expanded ? styles.expanded : ''}`}>
      <button className={styles.matchHead} type="button" onClick={onToggle} aria-expanded={expanded}>
        <span className={styles.kickoff}><b>{match.time || '—'}</b><small>COL</small></span>
        <span className={styles.matchIdentity}>
          <small>{match.league || 'Competición'}</small>
          <strong>{match.name}</strong>
          <span>{match.rows.length} opciones disponibles</span>
        </span>
        <span className={styles.matchSignal}>
          <small>Mayor</small><b>{metric(best?.probability)}</b><ChevronDown size={18} />
        </span>
      </button>
      {expanded && (
        <div className={styles.matchBody}>
          {grouped.map(([group, rows]) => (
            <section className={styles.marketGroup} key={group}>
              <header><span>{group}</span><b>{rows.length}</b></header>
              <div className={styles.marketList}>{rows.map((row, index) => (
                <MarketLine key={`${row.market_key}-${row.linea}-${index}`} row={row} />
              ))}</div>
            </section>
          ))}
        </div>
      )}
    </article>
  );
}

export default function MarketReports({ date, initialSport, reports, userEmail }) {
  const router = useRouter();
  const [sport, setSport] = useState(initialSport);
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('Todos');
  const [direction, setDirection] = useState('all');
  const [sort, setSort] = useState('time');
  const [expanded, setExpanded] = useState(null);
  const report = reports[sport];
  const allRows = report?.reportRows || [];
  const groups = useMemo(() => ['Todos', ...new Set(allRows.map(row => row.grupo))], [allRows]);

  const filteredRows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('es');
    return allRows.filter(row => (
      (group === 'Todos' || row.grupo === group)
      && (direction === 'all' || row.direccion === direction)
      && (!needle || `${row.partido} ${row.liga} ${row.linea} ${row.ambito}`.toLocaleLowerCase('es').includes(needle))
    ));
  }, [allRows, direction, group, search]);

  const matches = useMemo(() => {
    const result = groupRows(filteredRows);
    if (sort === 'probability') result.sort((a, b) => Math.max(...b.rows.map(row => Number(row.probability || 0))) - Math.max(...a.rows.map(row => Number(row.probability || 0))));
    else if (sort === 'reliability') result.sort((a, b) => Math.max(...b.rows.map(row => Number(row.reliability || 0))) - Math.max(...a.rows.map(row => Number(row.reliability || 0))));
    else result.sort((a, b) => String(a.time).localeCompare(String(b.time)) || a.name.localeCompare(b.name, 'es'));
    return result;
  }, [filteredRows, sort]);

  const navigateDate = (next) => router.push(`/ferney/informes?date=${encodeURIComponent(next)}&deporte=${sport}`);
  const changeSport = (next) => {
    setSport(next); setGroup('Todos'); setDirection('all'); setExpanded(null);
    window.history.replaceState(null, '', `/ferney/informes?date=${encodeURIComponent(date)}&deporte=${next}`);
  };
  const reliableCount = filteredRows.filter(row => Number(row.reliability) >= 90).length;

  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.brandLine}><span>CF</span><b>INFORMES PRIVADOS</b><small>{userEmail}</small></div>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}><CircleGauge size={15} /> Radar diario · {SPORT_COPY[sport].accent}</span>
          <h1>Cada partido. <em>Cada señal.</em></h1>
          <p>Abre un encuentro y revisa sus mercados sin desplazarte por una hoja de cálculo interminable.</p>
        </div>
        <div className={styles.dateBar}>
          <button type="button" onClick={() => navigateDate(shiftDate(date, -1))} aria-label="Día anterior"><ChevronLeft /></button>
          <label><CalendarDays size={17} /><span>{formatDate(date)}</span><input type="date" value={date} onChange={event => navigateDate(event.target.value)} /></label>
          <button type="button" onClick={() => navigateDate(shiftDate(date, 1))} aria-label="Día siguiente"><ChevronRight /></button>
        </div>
      </header>

      <section className={styles.workspace}>
        <div className={styles.sportTabs} role="tablist" aria-label="Deporte del informe">
          {Object.entries(SPORT_COPY).map(([key, copy]) => (
            <button type="button" role="tab" aria-selected={sport === key} key={key} className={sport === key ? styles.active : ''} onClick={() => changeSport(key)}>
              {key === 'futbol' ? <Trophy size={17} /> : <BarChart3 size={17} />}{copy.label}
              <span>{reports[key]?.rows || 0}</span>
            </button>
          ))}
        </div>

        <div className={styles.summaryGrid}>
          <article><span><BarChart3 size={18} /></span><div><small>Partidos con datos</small><b>{matches.length}</b></div></article>
          <article><span><CircleGauge size={18} /></span><div><small>Mercados visibles</small><b>{filteredRows.length}</b></div></article>
          <article><span><ShieldCheck size={18} /></span><div><small>Fiabilidad ≥90%</small><b>{reliableCount}</b></div></article>
        </div>

        <div className={styles.toolbar}>
          <label className={styles.search}><Search size={17} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar equipo, liga o mercado" /></label>
          <a className={styles.download} href={`/api/admin/personal-market-report?sport=${sport}&date=${date}`}><ArrowDownToLine size={17} /> CSV limpio</a>
        </div>

        <div className={styles.filterPanel}>
          <div className={styles.filterTitle}><Filter size={15} /><span>Mercados</span></div>
          <div className={styles.chips}>{groups.map(value => <button type="button" aria-pressed={group === value} key={value} className={group === value ? styles.selected : ''} onClick={() => setGroup(value)}>{value}</button>)}</div>
          <div className={styles.secondaryFilters}>
            <div className={styles.directionTabs}>
              {[['all', 'Todos'], ['over', 'Más de'], ['under', 'Menos de']].map(([key, label]) => <button type="button" aria-pressed={direction === key} key={key} className={direction === key ? styles.selected : ''} onClick={() => setDirection(key)}>{label}</button>)}
            </div>
            <select value={sort} onChange={event => setSort(event.target.value)} aria-label="Orden del informe">
              <option value="time">Ordenar por hora</option>
              <option value="probability">Mayor probabilidad</option>
              <option value="reliability">Mayor fiabilidad</option>
            </select>
          </div>
        </div>

        <div className={styles.resultsHead}><span>{matches.length} partidos</span><small>Presiona un partido para ver sus opciones</small></div>
        <div className={styles.matches}>
          {matches.map(match => <MatchCard key={match.id} match={match} expanded={expanded === match.id} onToggle={() => setExpanded(value => value === match.id ? null : match.id)} />)}
          {!matches.length && <div className={styles.empty}><BarChart3 size={28} /><h2>Sin mercados para estos filtros</h2><p>Cambia el mercado, la dirección o la fecha.</p></div>}
        </div>
        <p className={styles.disclaimer}>Las probabilidades son frecuencias observadas, no garantías. La fiabilidad mide cuánto respalda la muestra histórica cada señal.</p>
      </section>
    </main>
  );
}
