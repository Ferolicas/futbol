'use client';

import { Children, useState } from 'react';
import { Check, ChevronDown, ChevronLeft } from 'lucide-react';
import MarketOutcomeBadge from './MarketOutcomeBadge';
import PredictionSealBadge from './PredictionSealBadge';
import { displayBettingText } from '../utils/display-betting-text';

/*
 * Piezas del "análisis completo" compartidas por los cuatro deportes — son
 * la traducción 1:1 de apps/cfanalisis-mobile/src/components/analysis/
 * FullAnalysisKit.tsx, para que la web se vea igual que la app. Regla de
 * simetría: cada fila de datos se reparte en columnas de igual ancho y las
 * secciones son acordeones abiertos por defecto.
 */

export const prob = (entry) => {
  if (entry == null) return null;
  const raw = Number(entry?.rawProbability);
  if (Number.isFinite(raw)) return raw <= 1 ? raw * 100 : raw;
  const value = Number(typeof entry === 'object' ? entry?.probability : entry);
  return Number.isFinite(value) ? value : null;
};
export const pctText = (entry) => {
  const value = prob(entry);
  return value == null ? '—' : `${(Math.floor(Math.min(95, Math.max(0, value)) * 100) / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
};
export const numText = (value, decimals = 2) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(decimals);
export const capPct = (v) => {
  const value = Math.max(0, Math.min(100, Number(v) || 0));
  return value >= 95 ? 95 : Math.floor((value + 1e-9) * 100) / 100;
};
const sortedLines = (lines) => Object.entries(lines || {}).sort((l, r) => Number(l[0]) - Number(r[0]));

export function DocPage({ onBack, title, embedded = false, children }) {
  return (
    <main className={`fak-page app ${embedded ? 'is-embedded' : ''}`}>
      {!embedded && (
        <div className="fak-topbar">
          <button type="button" className="fak-back" onClick={onBack} aria-label="Volver"><ChevronLeft size={17} aria-hidden="true" /> Volver</button>
          <span className="fak-kicker">{title}</span>
        </div>
      )}
      <div className="fak-doc">{children}</div>
    </main>
  );
}

/** Sección colapsable (abierta por defecto, igual que la app). */
export function AccordionSection({ title, icon: Icon, accent = '#5ee6b1', count, hint, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="fak-section">
      <button type="button" className="fak-section-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {Icon && <span className="fak-section-icon" style={{ background: `${accent}1f` }}><Icon size={17} color={accent} aria-hidden="true" /></span>}
        <span className="fak-section-title">{title}</span>
        {count != null && <span className="fak-count">{count}</span>}
        <ChevronDown size={18} className={`fak-chev ${open ? 'is-open' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="fak-section-body">
          {hint && <p className="fak-hint">{hint}</p>}
          {children}
        </div>
      )}
    </section>
  );
}

/** Acordeón secundario dentro de una sección. */
export function SubAccordion({ title, meta, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="fak-sub">
      <button type="button" className="fak-sub-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="fak-sub-title">{title}</span>
        {meta && <small>{meta}</small>}
        <ChevronDown size={16} className={`fak-chev ${open ? 'is-open' : ''}`} aria-hidden="true" />
      </button>
      {open && <div className="fak-sub-body">{children}</div>}
    </div>
  );
}

export function Panel({ title, children }) {
  return <div className="fak-panel">{title && <span className="fak-kicker">{title}</span>}{children}</div>;
}

/** Malla de N columnas de igual ancho; la última fila se completa con huecos. */
export function Grid({ columns = 2, children }) {
  const items = Children.toArray(children).filter(Boolean);
  if (!items.length) return null;
  const pad = (columns - (items.length % columns)) % columns;
  return (
    <div className="fak-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {items}
      {Array.from({ length: pad }).map((_, i) => <span key={`pad-${i}`} aria-hidden="true" />)}
    </div>
  );
}

export function StatTile({ label, value, color = '#5ee6b1', sub }) {
  return (
    <div className="fak-tile">
      <small title={label}>{label}</small>
      <strong style={{ color }}>{value}</strong>
      {sub && <em>{sub}</em>}
    </div>
  );
}

export function ProbTile({ label, value, color = '#5ee6b1' }) {
  if (prob(value) == null) return null;
  return <StatTile label={label} value={pctText(value)} color={color} />;
}

export function ExpectedRow({ value, homeName, awayName, totalLabel = 'Total' }) {
  if (!value || ![value.home, value.total, value.away].some((v) => v != null && Number.isFinite(Number(v)))) return null;
  return (
    <Grid columns={3}>
      <StatTile label={homeName} value={numText(value.home)} sub="media" />
      <StatTile label={totalLabel} value={numText(value.total)} color="#22d3ee" sub="media" />
      <StatTile label={awayName} value={numText(value.away)} sub="media" />
    </Grid>
  );
}

/** Ganador en tiles iguales (2 o 3 según haya empate). */
export function MoneylineTiles({ moneyline, homeName, awayName }) {
  const draw = moneyline?.draw ?? moneyline?.tie;
  const tiles = [[homeName, moneyline?.home], ...(prob(draw) != null ? [['Empate', draw]] : []), [awayName, moneyline?.away]].filter(([, v]) => prob(v) != null);
  if (!tiles.length) return null;
  return <Grid columns={tiles.length}>{tiles.map(([label, value]) => <ProbTile key={label} label={label} value={value} color={label === 'Empate' ? '#fbbf24' : '#5ee6b1'} />)}</Grid>;
}

/** Tabla simétrica: línea | Más | Menos. */
export function OverUnderTable({ lines, unit }) {
  const entries = sortedLines(lines);
  if (!entries.length) return null;
  return (
    <div className="fak-table">
      <div className="fak-tr is-head"><span>Línea</span><span>Más</span><span>Menos</span></div>
      {entries.map(([line, values]) => {
        const n = values?.evidence?.over?.n ?? values?.evidence?.under?.n;
        return (
          <div key={line} className="fak-tr">
            <span className="fak-line">{line}{unit ? ` ${unit}` : ''}{n ? <small> n={n}</small> : null}</span>
            <b className="is-over">{pctText(values?.over)}</b>
            <b className="is-under">{pctText(values?.under)}</b>
          </div>
        );
      })}
    </div>
  );
}

/** Tabla simétrica por equipo: línea | local | visitante (más de). */
export function CompareTable({ homeLines, awayLines, homeName, awayName }) {
  const lines = [...new Set([...Object.keys(homeLines || {}), ...Object.keys(awayLines || {})])].map(Number).filter(Number.isFinite).sort((l, r) => l - r);
  if (!lines.length) return null;
  return (
    <div className="fak-table">
      <div className="fak-tr is-head"><span>Más de</span><span className="is-team" title={homeName}>{homeName}</span><span className="is-team" title={awayName}>{awayName}</span></div>
      {lines.map((line) => (
        <div key={line} className="fak-tr">
          <span className="fak-line">{line}</span>
          <b className="is-over">{pctText(homeLines?.[line]?.over)}</b>
          <b className="is-over">{pctText(awayLines?.[line]?.over)}</b>
        </div>
      ))}
    </div>
  );
}

/** Hándicaps: una columna por equipo. */
export function SpreadColumns({ values, homeName, awayName }) {
  const home = sortedLines(values?.home);
  const away = sortedLines(values?.away);
  if (!home.length && !away.length) return null;
  const Column = ({ name, entries }) => (
    <div className="fak-table">
      <div className="fak-tr is-head is-single"><span className="is-team" title={name}>{name}</span></div>
      {entries.map(([line, value]) => (
        <div key={line} className="fak-tr is-pair"><span className="fak-line">{Number(line) > 0 ? '+' : ''}{line}</span><b className="is-over">{pctText(value)}</b></div>
      ))}
    </div>
  );
  return <Grid columns={2}><Column name={homeName} entries={home} /><Column name={awayName} entries={away} /></Grid>;
}

export function KeyValue({ label, value, color = '#5ee6b1' }) {
  return <div className="fak-kv"><span>{label}</span><b style={{ color }}>{value}</b></div>;
}

/** Historial directo en columnas fijas: fecha | local | marcador | visitante. */
export function H2HTable({ rows }) {
  return (
    <div className="fak-h2h">
      {rows.map((h, i) => (
        <div key={i} className="fak-h2h-row">
          <small>{h.date ? new Date(h.date).toLocaleDateString('es', { day: '2-digit', month: 'short', year: '2-digit' }) : ''}</small>
          <span className="is-home">{h.home}</span>
          <b>{h.hs ?? '-'}–{h.as ?? '-'}</b>
          <span>{h.away}</span>
        </div>
      ))}
    </div>
  );
}

/** Marcador de cabecera para béisbol/multideporte: dos columnas idénticas. */
export function SportHero({ kicker, homeName, awayName, homeLogo, awayLogo, homeScore, awayScore, homeProb, awayProb, startTime, badges }) {
  const side = (label, name, logo, score, win) => (
    <div className="fak-hero-side">
      <small>{label}</small>
      {logo !== undefined && (logo ? <img src={logo} alt="" width="40" height="40" loading="lazy" /> : <span className="fak-hero-logo-fallback">{String(name || '?').charAt(0)}</span>)}
      <strong>{name}</strong>
      <b>{score ?? '—'}</b>
      {prob(win) != null && <em>Gana {pctText(win)}</em>}
    </div>
  );
  return (
    <header className="fak-hero">
      <span className="fak-kicker">{kicker}</span>
      <div className="fak-hero-teams">
        {side('Local', homeName, homeLogo, homeScore, homeProb)}
        <span className="fak-vs">VS</span>
        {side('Visitante', awayName, awayLogo, awayScore, awayProb)}
      </div>
      {startTime && <time>{new Date(startTime).toLocaleString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time>}
      {badges?.length > 0 && (
        <div className="fak-badges">
          {badges.map(([label, color]) => <span key={label} style={{ color, borderColor: `${color}66`, background: `${color}1a` }}>{label}</span>)}
        </div>
      )}
    </header>
  );
}

/** Tarjeta de mercado (misma que MarketButton de la app). */
export function MarketCard({ name, probability, odd, bookmaker, reliability, expectedValue, validation, seal, selected, onClick, outcome, pendingLabel }) {
  const pct = capPct(probability);
  const color = pct >= 75 ? '#5ee6b1' : pct >= 50 ? '#fbbf24' : '#8fa1aa';
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`fak-market ${selected ? 'is-on' : ''}`} onClick={onClick} aria-pressed={onClick ? !!selected : undefined}>
      <strong className="fak-market-name">{displayBettingText(name)}</strong>
      {validation && <small className={String(validation).startsWith('Recomendación') ? 'is-accent' : ''}>{validation}</small>}
      {seal && <PredictionSealBadge seal={seal} />}
      <MarketOutcomeBadge outcome={outcome} pendingLabel={pendingLabel} compact />
      <span className="fak-bar"><span style={{ width: `${pct}%`, background: color }} /></span>
      <span className="fak-market-nums">
        <b style={{ color }}>{pct}%</b>
        {odd ? <b className="is-odd">{Number(odd).toFixed(2)}</b> : null}
        {reliability != null && Number.isFinite(Number(reliability)) && <small className="is-cyan">Fiab. {Number(reliability).toFixed(1)}%</small>}
        {expectedValue != null && Number.isFinite(Number(expectedValue)) && <small>EV {Number(expectedValue) >= 0 ? '+' : ''}{(Number(expectedValue) * 100).toFixed(1)}%</small>}
        {bookmaker && <small className="is-bk">{bookmaker}</small>}
        {selected && <span className="fak-check"><Check size={12} aria-hidden="true" /></span>}
      </span>
    </Tag>
  );
}
