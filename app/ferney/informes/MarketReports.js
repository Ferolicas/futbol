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
  Flag,
  History,
  Search,
  ShieldCheck,
  Target,
  Trophy,
} from 'lucide-react';
import styles from './MarketReports.module.css';

const SPORT_COPY = Object.freeze({
  futbol: { label: 'Fútbol', accent: 'Córners 1.ª parte' },
  baseball: { label: 'Béisbol', accent: 'MLB' },
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

function decimal(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function metric(value, maximum = 100) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${Math.min(maximum, Math.floor((Number(value) + 1e-9) * 100) / 100)}%`;
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
        <span><small>Prob.</small><b>{metric(row.probability, 95)}</b></span>
        <span><small>Fiab.</small><b>{metric(row.reliability)}</b></span>
        {row.odd != null && <span><small>Cuota</small><b>{Number(row.odd).toFixed(2)}</b></span>}
      </div>
      <span className={styles.probabilityBar} style={{ '--market-probability': `${probability}%` }} />
    </article>
  );
}

function BaseballMatchCard({ match, expanded, onToggle }) {
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
          <small>Mayor</small><b>{metric(best?.probability, 95)}</b><ChevronDown size={18} />
        </span>
      </button>
      {expanded && (
        <div className={styles.matchBody}>
          {grouped.map(([group, rows]) => (
            <details className={styles.marketGroup} key={group}>
              <summary><span>{group}</span><b>{rows.length}</b><ChevronDown size={16} /></summary>
              <div className={styles.marketList}>{rows.map((row, index) => (
                <MarketLine key={`${row.market_key}-${row.linea}-${index}`} row={row} />
              ))}</div>
            </details>
          ))}
        </div>
      )}
    </article>
  );
}

function RecentCorners({ team }) {
  return (
    <section className={styles.recentTeam}>
      <header><div><strong>{team.name}</strong><span>Promedio 2026: {decimal(team.average)} · {team.sample} partidos</span></div></header>
      <div className={styles.recentList}>
        {team.recent.map((match) => (
          <article key={`${team.teamId}-${match.fixtureId}`}>
            <time>{match.date}</time>
            <span><small>{match.isHome ? 'LOCAL' : 'VISITANTE'}</small><b>vs {match.opponent}</b></span>
            <strong>{match.corners}<small> córners</small></strong>
          </article>
        ))}
        {!team.recent.length && <p>Sin partidos de 2026 con córners de primera parte disponibles.</p>}
      </div>
    </section>
  );
}

function FootballMatchCard({ match }) {
  return (
    <article className={styles.cornerMatchCard}>
      <header className={styles.cornerMatchHead}>
        <span className={styles.kickoff}><b>{match.time || '—'}</b><small>COL</small></span>
        <span className={styles.matchIdentity}>
          <small>{match.league}</small>
          <strong>{match.home.name} vs {match.away.name}</strong>
          <span>Córners realizados por cada equipo antes del descanso</span>
        </span>
      </header>
      <div className={styles.expectedLine}>
        <Flag size={22} />
        <span><small>CÓRNERS ESPERADOS · 1.ª PARTE</small><strong>{match.expectedCorners == null ? 'Sin muestra suficiente' : `${decimal(match.expectedCorners, 1)} córners`}</strong></span>
      </div>
      <div className={styles.teamAverages}>
        <span><small>{match.home.name}</small><b>{decimal(match.home.average)}</b><em>{match.home.sample} partidos</em></span>
        <span aria-hidden="true">+</span>
        <span><small>{match.away.name}</small><b>{decimal(match.away.average)}</b><em>{match.away.sample} partidos</em></span>
      </div>
      <div className={styles.recentGrid}>
        <RecentCorners team={match.home} />
        <RecentCorners team={match.away} />
      </div>
    </article>
  );
}

function TeamHistory({ report, teamSearch, setTeamSearch, onSelectTeam }) {
  const needle = teamSearch.trim().toLocaleLowerCase('es');
  const visibleTeams = report.teams.filter((team) => (
    !needle || `${team.name} ${team.country}`.toLocaleLowerCase('es').includes(needle)
  ));
  const selected = report.selectedTeam;
  return (
    <section className={styles.teamExplorer}>
      <div className={styles.explorerTitle}>
        <span><History size={18} /></span>
        <div><h2>Historial completo por equipo</h2><p>Todos sus partidos oficiales jugados desde el 1 de enero de 2026. No incluye amistosos.</p></div>
      </div>
      <div className={styles.teamPicker}>
        <label className={styles.search}><Search size={17} /><input value={teamSearch} onChange={(event) => setTeamSearch(event.target.value)} placeholder="Filtrar equipos del sistema" /></label>
        <select value={selected?.teamId || ''} onChange={(event) => onSelectTeam(event.target.value)} aria-label="Seleccionar equipo">
          <option value="">Selecciona un equipo</option>
          {visibleTeams.map((team) => <option value={team.teamId} key={team.teamId}>{team.name}{team.country ? ` · ${team.country}` : ''} ({team.coveredMatches}/{team.matches})</option>)}
        </select>
      </div>
      {selected && (
        <div className={styles.selectedHistory}>
          <header>
            <div><small>EQUIPO SELECCIONADO</small><h3>{selected.name}</h3></div>
            <div><span><b>{decimal(selected.average)}</b><small>promedio 1T</small></span><span><b>{selected.coveredMatches}/{selected.matches}</b><small>con cobertura</small></span></div>
          </header>
          <div className={styles.historyRows}>
            {selected.history.map((match) => (
              <article key={match.fixtureId} className={match.corners == null ? styles.noCoverage : ''}>
                <time>{match.date}</time>
                <span><small>{match.league} · {match.isHome ? 'Local' : 'Visitante'}</small><b>vs {match.opponent}</b></span>
                <strong>{match.corners == null ? 'Sin cobertura' : <>{match.corners}<small> córners 1T</small></>}</strong>
              </article>
            ))}
          </div>
        </div>
      )}
      {!selected && <div className={styles.explorerEmpty}><Target size={25} /><p>Elige un equipo para ver cada partido de 2026 y los córners que hizo en la primera parte.</p></div>}
    </section>
  );
}

function BaseballReport({ report, search, setSearch, group, setGroup, direction, setDirection, sort, setSort, expanded, setExpanded }) {
  const allRows = report?.reportRows || [];
  const groups = useMemo(() => ['Todos', ...new Set(allRows.map((row) => row.grupo))], [allRows]);
  const filteredRows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('es');
    return allRows.filter((row) => (
      (group === 'Todos' || row.grupo === group)
      && (direction === 'all' || row.direccion === direction)
      && (!needle || `${row.partido} ${row.liga} ${row.linea} ${row.ambito}`.toLocaleLowerCase('es').includes(needle))
    ));
  }, [allRows, direction, group, search]);
  const matches = useMemo(() => {
    const result = groupRows(filteredRows);
    if (sort === 'probability') result.sort((a, b) => Math.max(...b.rows.map((row) => Number(row.probability || 0))) - Math.max(...a.rows.map((row) => Number(row.probability || 0))));
    else if (sort === 'reliability') result.sort((a, b) => Math.max(...b.rows.map((row) => Number(row.reliability || 0))) - Math.max(...a.rows.map((row) => Number(row.reliability || 0))));
    else result.sort((a, b) => String(a.time).localeCompare(String(b.time)) || a.name.localeCompare(b.name, 'es'));
    return result;
  }, [filteredRows, sort]);
  const reliableCount = filteredRows.filter((row) => Number(row.reliability) >= 90).length;

  return <>
    <div className={styles.summaryGrid}>
      <article><span><BarChart3 size={18} /></span><div><small>Partidos con datos</small><b>{matches.length}</b></div></article>
      <article><span><CircleGauge size={18} /></span><div><small>Mercados visibles</small><b>{filteredRows.length}</b></div></article>
      <article><span><ShieldCheck size={18} /></span><div><small>Fiabilidad ≥90%</small><b>{reliableCount}</b></div></article>
    </div>
    <div className={styles.toolbar}>
      <label className={styles.search}><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar equipo, liga o mercado" /></label>
      <a className={styles.download} href={`/api/admin/personal-market-report?sport=baseball&date=${report.date}`}><ArrowDownToLine size={17} /> CSV limpio</a>
    </div>
    <div className={styles.filterPanel}>
      <div className={styles.filterTitle}><BarChart3 size={15} /><span>Mercados</span></div>
      <div className={styles.chips}>{groups.map((value) => <button type="button" aria-pressed={group === value} key={value} className={group === value ? styles.selected : ''} onClick={() => setGroup(value)}>{value}</button>)}</div>
      <div className={styles.secondaryFilters}>
        <div className={styles.directionTabs}>{[['all', 'Todos'], ['over', 'Más de'], ['under', 'Menos de']].map(([key, label]) => <button type="button" aria-pressed={direction === key} key={key} className={direction === key ? styles.selected : ''} onClick={() => setDirection(key)}>{label}</button>)}</div>
        <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Orden del informe"><option value="time">Ordenar por hora</option><option value="probability">Mayor probabilidad</option><option value="reliability">Mayor fiabilidad</option></select>
      </div>
    </div>
    <div className={styles.resultsHead}><span>{matches.length} partidos</span><small>Presiona un partido para ver sus opciones</small></div>
    <div className={styles.matches}>
      {matches.map((match) => <BaseballMatchCard key={match.id} match={match} expanded={expanded === match.id} onToggle={() => setExpanded((value) => value === match.id ? null : match.id)} />)}
      {!matches.length && <div className={styles.empty}><BarChart3 size={28} /><h2>Sin mercados para estos filtros</h2><p>Cambia el mercado, la dirección o la fecha.</p></div>}
    </div>
  </>;
}

export default function MarketReports({ date, initialSport, reports, userEmail }) {
  const router = useRouter();
  const [sport, setSport] = useState(initialSport);
  const [search, setSearch] = useState('');
  const [teamSearch, setTeamSearch] = useState('');
  const [group, setGroup] = useState('Todos');
  const [direction, setDirection] = useState('all');
  const [sort, setSort] = useState('time');
  const [expanded, setExpanded] = useState(null);
  const football = reports.futbol;
  const navigateDate = (next) => {
    const team = sport === 'futbol' && football.selectedTeam ? `&equipo=${football.selectedTeam.teamId}` : '';
    router.push(`/ferney/informes?date=${encodeURIComponent(next)}&deporte=${sport}${team}`);
  };
  const changeSport = (next) => {
    setSport(next); setGroup('Todos'); setDirection('all'); setExpanded(null);
    window.history.replaceState(null, '', `/ferney/informes?date=${encodeURIComponent(date)}&deporte=${next}`);
  };
  const selectTeam = (teamId) => router.push(`/ferney/informes?date=${encodeURIComponent(date)}&deporte=futbol${teamId ? `&equipo=${encodeURIComponent(teamId)}` : ''}`);
  const isFootball = sport === 'futbol';

  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.brandLine}><span>CF</span><b>INFORMES PRIVADOS</b><small>{userEmail}</small></div>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>{isFootball ? <Flag size={15} /> : <CircleGauge size={15} />} {SPORT_COPY[sport].accent}</span>
          <h1>{isFootball ? <>Primera parte. <em>Solo córners.</em></> : <>Cada partido. <em>Cada señal.</em></>}</h1>
          <p>{isFootball ? 'Promedios reales de 2026, expectativa del encuentro y los últimos cinco partidos de cada equipo.' : 'Abre un encuentro y revisa sus mercados sin desplazarte por una hoja de cálculo interminable.'}</p>
        </div>
        <div className={styles.dateBar}>
          <button type="button" onClick={() => navigateDate(shiftDate(date, -1))} aria-label="Día anterior"><ChevronLeft /></button>
          <label><CalendarDays size={17} /><span>{formatDate(date)}</span><input type="date" value={date} onChange={(event) => navigateDate(event.target.value)} /></label>
          <button type="button" onClick={() => navigateDate(shiftDate(date, 1))} aria-label="Día siguiente"><ChevronRight /></button>
        </div>
      </header>

      <section className={styles.workspace}>
        <div className={styles.sportTabs} role="tablist" aria-label="Deporte del informe">
          {Object.entries(SPORT_COPY).map(([key, copy]) => (
            <button type="button" role="tab" aria-selected={sport === key} key={key} className={sport === key ? styles.active : ''} onClick={() => changeSport(key)}>
              {key === 'futbol' ? <Trophy size={17} /> : <BarChart3 size={17} />}{copy.label}<span>{reports[key]?.rows || 0}</span>
            </button>
          ))}
        </div>

        {isFootball ? <>
          <div className={styles.summaryGrid}>
            <article><span><Trophy size={18} /></span><div><small>{football.remainingOnly ? 'Partidos que quedan hoy' : 'Partidos del día'}</small><b>{football.matches.length}</b></div></article>
            <article><span><Flag size={18} /></span><div><small>Equipos con datos 1T</small><b>{football.coveredTeams}</b></div></article>
            <article><span><History size={18} /></span><div><small>Registros 2026</small><b>{football.coveredMatches}</b></div></article>
          </div>
          <div className={styles.cornerToolbar}>
            <p><CircleGauge size={16} /> La expectativa suma el promedio 2026 de córners realizados en 1.ª parte por ambos equipos.</p>
            <a className={styles.download} href={`/api/admin/personal-market-report?sport=futbol&date=${date}`}><ArrowDownToLine size={17} /> CSV</a>
          </div>
          <TeamHistory report={football} teamSearch={teamSearch} setTeamSearch={setTeamSearch} onSelectTeam={selectTeam} />
          <div className={styles.resultsHead}><span>{football.matches.length} partidos</span><small>{football.remainingOnly ? 'Solo encuentros pendientes de hoy' : 'Jornada completa'}</small></div>
          <div className={styles.cornerMatches}>
            {football.matches.map((match) => <FootballMatchCard key={match.fixtureId} match={match} />)}
            {!football.matches.length && <div className={styles.empty}><Flag size={28} /><h2>No quedan partidos para esta fecha</h2><p>Selecciona otro día para consultar su informe.</p></div>}
          </div>
        </> : <BaseballReport report={reports.baseball} search={search} setSearch={setSearch} group={group} setGroup={setGroup} direction={direction} setDirection={setDirection} sort={sort} setSort={setSort} expanded={expanded} setExpanded={setExpanded} />}

        <p className={styles.disclaimer}>{isFootball ? 'La expectativa es una media descriptiva de córners realizados, no una garantía ni una probabilidad de apuesta. “Sin cobertura” nunca se cuenta como cero.' : 'Las probabilidades son frecuencias observadas, no garantías. La fiabilidad mide cuánto respalda la muestra histórica cada señal.'}</p>
      </section>
    </main>
  );
}
