'use client';

import { Users, Split } from 'lucide-react';
import { AccordionSection, Panel, SubAccordion } from './FullAnalysisKit';

// Tablas de la NBA que el motor ya pondera en una sola cifra, mostradas aquí
// corte por corte: temporada, misma condición de local/visitante,
// enfrentamientos directos y forma reciente. Son conteos crudos, sin pesos.

const SEGMENTS = [
  ['season', 'Temporada'],
  ['venue', null], // la etiqueta depende de si el equipo juega de local o visitante
  ['h2h', 'Vs rival'],
  ['last5', 'Últimos 5'],
];

const num = (value, digits = 1) => (value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(digits));
const signed = (value) => (Number(value) > 0 ? `+${value}` : String(value));
const rate = (cell) => {
  if (!cell || !cell.n) return '—';
  return `${cell.hits}/${cell.n}`;
};
const ratePct = (cell) => (!cell || !cell.n ? null : Math.round((cell.hits / cell.n) * 100));
const toneOf = (pct) => (pct == null ? undefined : pct >= 65 ? '#5ee6b1' : pct <= 35 ? '#f87171' : '#c4d2d4');

const cols = (count) => ({ gridTemplateColumns: `minmax(0, 1.5fr) repeat(${count}, minmax(0, 1fr))` });

function Cell({ cell }) {
  const pct = ratePct(cell);
  return (
    <b style={{ color: toneOf(pct) }} title={pct == null ? 'Sin partidos en este corte' : `${pct}%`}>
      {rate(cell)}{pct != null && <small style={{ display: 'block', color: '#5f707a', fontWeight: 500 }}>{pct}%</small>}
    </b>
  );
}

function TeamTables({ team, name }) {
  if (!team) return null;
  const venueLabel = team.venueLabel === 'local' ? 'De local' : 'De visitante';
  const segments = SEGMENTS.map(([key, label]) => [key, label || venueLabel]);
  return (
    <>
      <Panel title={`${name} · promedios`}>
        <div className="fak-table">
          <div className="fak-tr is-head" style={cols(5)}><span>Corte</span><span>PJ</span><span>Anota</span><span>Recibe</span><span>1.er C</span><span>Reb.</span></div>
          {segments.map(([key, label]) => {
            const row = team.segments?.[key];
            return (
              <div key={key} className="fak-tr" style={cols(5)}>
                <span className="fak-line">{label}</span>
                <b>{row?.n ?? 0}</b>
                <b>{num(row?.pointsFor)}</b>
                <b>{num(row?.pointsAgainst)}</b>
                <b>{num(row?.q1For)}</b>
                <b>{num(row?.rebounds)}</b>
              </div>
            );
          })}
        </div>
      </Panel>
      <Panel title={`${name} · cada mercado por corte`}>
        <div className="fak-table">
          <div className="fak-tr is-head" style={cols(4)}><span>Mercado</span>{segments.map(([key, label]) => <span key={key}>{label}</span>)}</div>
          {(team.markets || []).map((market) => (
            <div key={market.key} className="fak-tr" style={cols(4)}>
              <span className="fak-line" style={{ whiteSpace: 'normal' }}>
                {market.label}{market.line != null ? ` ${/[Hh]ándicap/.test(market.label) ? signed(market.line) : market.line}` : ''}
                {market.line != null && !market.fromOdds && <small> (línea media)</small>}
              </span>
              {segments.map(([key]) => <Cell key={key} cell={market.segments?.[key]} />)}
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}

export function TeamBreakdownSection({ breakdown, homeName, awayName }) {
  if (!breakdown?.home && !breakdown?.away) return null;
  return (
    <AccordionSection title="Desglose por equipo: local, visitante y h2h" icon={Split} accent="#38bdf8"
      hint="Aciertos sobre partidos jugados en cada corte. La línea es la principal de Bet365 cuando existe; si no, la mediana del equipo.">
      <SubAccordion title={homeName} meta="juega de local" defaultOpen><TeamTables team={breakdown.home} name={homeName} /></SubAccordion>
      <SubAccordion title={awayName} meta="juega de visitante"><TeamTables team={breakdown.away} name={awayName} /></SubAccordion>
    </AccordionSection>
  );
}

const PLAYER_METRICS = [
  ['points', 'Puntos'],
  ['q1Points', 'Puntos en el 1.er cuarto'],
  ['rebounds', 'Rebotes'],
  ['q1Rebounds', 'Rebotes en el 1.er cuarto'],
  ['assists', 'Asistencias'],
  ['threePointersMade', 'Triples'],
];

const linePct = (side) => {
  const raw = side?.rawProbability != null ? Number(side.rawProbability) * 100 : Number(side?.probability);
  return Number.isFinite(raw) ? Math.min(95, Math.floor(raw)) : null;
};

function PlayerCard({ player }) {
  const venueLabel = player.side === 'home' ? 'Local' : 'Visit.';
  const lines = Object.keys(player.lineSides || {}).map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  return (
    <Panel title={`${player.name}${player.starter ? ' · titular' : ''}`}>
      <div className="fak-kv"><span>Promedio ({player.games} partidos)</span><b>{num(player.mean)}</b></div>
      <div className="fak-kv"><span>Temporada · {venueLabel} · vs rival</span>
        <b>{num(player.means?.season?.mean)} · {num(player.means?.venue?.mean)} · {num(player.means?.h2h?.mean)}</b></div>
      <div className="fak-kv"><span>Últimos {Math.min(10, (player.recent || []).length)}</span><b>{(player.recent || []).join(' · ') || '—'}</b></div>
      <div className="fak-table">
        <div className="fak-tr is-head" style={cols(5)}><span>Más de</span><span>Motor</span><span>Temp.</span><span>{venueLabel}</span><span>Vs rival</span><span>Últ. 10</span></div>
        {lines.map((line) => {
          const pct = linePct(player.lineSides[line]?.over);
          const split = player.splits?.[line] || {};
          return (
            <div key={line} className="fak-tr" style={cols(5)}>
              <span className="fak-line">{line}</span>
              <b style={{ color: toneOf(pct) }}>{pct == null ? '—' : `${pct}%`}</b>
              <Cell cell={split.season} /><Cell cell={split.venue} /><Cell cell={split.h2h} /><Cell cell={split.last10} />
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export function PlayerMarketsSection({ playerMarkets, meta, homeName, awayName }) {
  const metrics = PLAYER_METRICS.filter(([key]) => (playerMarkets?.[key] || []).length > 0);
  if (!metrics.length) return null;
  const excluded = meta?.excluded || [];
  return (
    <AccordionSection title="Jugadores: puntos, rebotes y 1.er cuarto" icon={Users} accent="#f472b6" count={metrics.length}
      hint="«Motor» es la frecuencia ponderada por localía, rival y temporada. Las demás columnas son aciertos/partidos de cada corte.">
      {excluded.length > 0 && (
        <p className="fak-hint">Fuera por baja reportada: {excluded.map((player) => player.name).join(', ')}.</p>
      )}
      {metrics.map(([key, label], index) => (
        <SubAccordion key={key} title={label} defaultOpen={index === 0}>
          {[['home', homeName], ['away', awayName]].map(([side, teamName]) => {
            const players = (playerMarkets[key] || []).filter((player) => player.side === side);
            if (!players.length) return null;
            return (
              <SubAccordion key={side} title={teamName} meta={`${players.length} jugadores`} defaultOpen={side === 'home' && index === 0}>
                {players.map((player) => <PlayerCard key={player.id} player={player} />)}
              </SubAccordion>
            );
          })}
        </SubAccordion>
      ))}
    </AccordionSection>
  );
}
