'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Check, LoaderCircle, NotebookPen } from 'lucide-react';
import { displayBettingText } from '../utils/display-betting-text';

// "Abrir apuesta sin dinero": registra las selecciones de la combinada con un
// importe ficticio. Es el espejo de lo que el propietario abre de verdad en la
// casa, así que la cuota de cada selección se puede corregir a la que le
// dieron realmente.

const STAKE_KEY = 'cf-paper-bet-stake';
const money = (value) => Number(value).toLocaleString('es', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PaperBetOpener({ selections = [], sport }) {
  const [stake, setStake] = useState('10');
  const [odds, setOdds] = useState({});
  const [groupOdds, setGroupOdds] = useState({});
  const [state, setState] = useState('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STAKE_KEY);
      if (saved && Number(saved) > 0) setStake(saved);
    } catch {}
  }, []);

  const legs = useMemo(() => selections.map((selection) => {
    const key = `${selection.fixtureId}|${selection.id ?? selection.marketKey}`;
    const typed = odds[key];
    return { selection, key, odd: typed != null && typed !== '' ? Number(typed) : Number(selection.odd) };
  }), [selections, odds]);

  // Al cambiar la combinada, lo abierto antes deja de corresponder a lo que se ve.
  const signature = legs.map((leg) => leg.key).join(',');
  useEffect(() => { setState('idle'); setError(''); }, [signature]);

  // Varias opciones de un mismo partido son un «Crear apuesta»: la casa da una
  // sola cuota para el conjunto y hay que escribirla, no se puede calcular.
  const builders = useMemo(() => {
    const byFixture = new Map();
    for (const leg of legs) {
      const fixture = String(leg.selection.fixtureId);
      if (!byFixture.has(fixture)) byFixture.set(fixture, []);
      byFixture.get(fixture).push(leg);
    }
    return [...byFixture.entries()].filter(([, group]) => group.length > 1)
      .map(([fixture, group]) => ({ fixture, matchName: group[0].selection.matchName, count: group.length }));
  }, [legs]);
  const builderFixtures = new Set(builders.map((builder) => builder.fixture));
  const builderOdd = (fixture) => Number(groupOdds[fixture]);

  if (!selections.length) return null;
  const singles = legs.filter((leg) => !builderFixtures.has(String(leg.selection.fixtureId)));
  const validOdds = singles.every((leg) => Number.isFinite(leg.odd) && leg.odd > 1)
    && builders.every((builder) => Number.isFinite(builderOdd(builder.fixture)) && builderOdd(builder.fixture) > 1);
  const totalOdd = validOdds
    ? singles.reduce((product, leg) => product * leg.odd, 1) * builders.reduce((product, builder) => product * builderOdd(builder.fixture), 1)
    : null;
  const stakeNumber = Number(stake);
  const validStake = Number.isFinite(stakeNumber) && stakeNumber > 0;

  const open = async () => {
    if (!validOdds || !validStake || state === 'busy') return;
    setState('busy');
    setError('');
    try {
      window.localStorage.setItem(STAKE_KEY, String(stakeNumber));
    } catch {}
    try {
      const response = await fetch('/api/paper-bets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stake: stakeNumber,
          legs: legs.map(({ selection, odd }) => ({
            sport: selection.sport || sport,
            source: 'recommended',
            id: String(selection.id ?? selection.marketKey ?? ''),
            fixtureId: String(selection.fixtureId),
            name: displayBettingText(selection.name || selection.market || selection.pick || ''),
            matchName: selection.matchName,
            homeTeam: selection.homeTeam || null,
            awayTeam: selection.awayTeam || null,
            kickoff: selection.matchTime ? new Date(selection.matchTime).toISOString() : null,
            odd: Number.isFinite(odd) && odd > 1 ? odd : 1.01,
            groupOdd: builderFixtures.has(String(selection.fixtureId)) ? builderOdd(String(selection.fixtureId)) : null,
            probability: Math.min(100, Number(selection.rawProbability ?? selection.probability)) || null,
            reliability: Number(selection.reliability ?? selection.confidence) || null,
            line: selection.line ?? null,
            side: selection.side || null,
            scope: selection.scope || null,
            bookmaker: selection.bookmaker || null,
          })),
        }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'No se pudo abrir la apuesta');
      setState('done');
    } catch (cause) {
      setError(cause.message);
      setState('idle');
    }
  };

  return (
    <section className="paper-opener" aria-label="Abrir apuesta sin dinero">
      <header className="paper-opener-head">
        <NotebookPen size={17} aria-hidden="true" />
        <span><strong>Apuesta sin dinero</strong><small>Regístrala tal como la abriste en la casa</small></span>
      </header>
      <div className="paper-opener-legs">
        {legs.map(({ selection, key, odd }) => {
          const inBuilder = builderFixtures.has(String(selection.fixtureId));
          return (
            <label key={key} className={`paper-opener-leg${inBuilder ? ' is-builder' : ''}`}>
              <span><small>{selection.matchName}</small>{displayBettingText(selection.name || selection.market || '')}</span>
              {inBuilder
                ? <em>Crear apuesta</em>
                : <input type="number" inputMode="decimal" step="0.01" min="1.01" aria-label={`Cuota de ${selection.name || selection.market}`}
                  value={odds[key] ?? (Number.isFinite(odd) ? String(odd) : '')}
                  onChange={(event) => setOdds((previous) => ({ ...previous, [key]: event.target.value }))} />}
            </label>
          );
        })}
        {builders.map((builder) => (
          <label key={builder.fixture} className="paper-opener-leg is-builder-odd">
            <span><small>{builder.matchName}</small>Cuota de «Crear apuesta» ({builder.count} opciones)</span>
            <input type="number" inputMode="decimal" step="0.01" min="1.01" required placeholder="Cuota"
              aria-label={`Cuota de Crear apuesta de ${builder.matchName}`}
              value={groupOdds[builder.fixture] ?? ''}
              onChange={(event) => setGroupOdds((previous) => ({ ...previous, [builder.fixture]: event.target.value }))} />
          </label>
        ))}
      </div>
      {builders.length > 0 && <p className="paper-hint">Varias opciones del mismo partido no se multiplican: escribe la cuota que te da la casa para ese «Crear apuesta».</p>}
      <div className="paper-opener-row">
        <label className="paper-opener-stake">
          <span>Importe ficticio</span>
          <input type="number" inputMode="decimal" min="0.01" step="0.01" value={stake} onChange={(event) => setStake(event.target.value)} />
        </label>
        <div className="paper-opener-total">
          <span>Cuota total <b>{totalOdd ? totalOdd.toFixed(2) : '—'}</b></span>
          <span>Ganancia posible <b>{totalOdd && validStake ? money(stakeNumber * totalOdd) : '—'}</b></span>
        </div>
      </div>
      {error && <p className="paper-opener-error" role="alert">{error}</p>}
      {state === 'done' ? (
        <p className="paper-opener-done"><Check size={16} aria-hidden="true" /> Apuesta registrada. <Link href="/dashboard/apuestas">Ver mis apuestas</Link></p>
      ) : (
        <button type="button" className="paper-opener-submit" onClick={open} disabled={!validOdds || !validStake || state === 'busy'}>
          {state === 'busy' ? <LoaderCircle size={16} className="btn-share-spin" aria-hidden="true" /> : <NotebookPen size={16} aria-hidden="true" />}
          {state === 'busy' ? 'Registrando…' : 'Abrir apuesta sin dinero'}
        </button>
      )}
    </section>
  );
}
