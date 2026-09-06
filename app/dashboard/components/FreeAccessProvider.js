'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { SWRConfig } from 'swr';
import { Eye, LockKeyhole, Sparkles, X } from 'lucide-react';
import MarketOutcomeBadge from './MarketOutcomeBadge';

const AccessContext = createContext({ isFree: false, openPlans: () => {} });
export const useFreeAccess = () => useContext(AccessContext);
const PLANS = [['semanal', 'Semanal'], ['mensual', 'Mensual'], ['trimestral', 'Trimestral'], ['semestral', 'Semestral'], ['anual', 'Anual']];

export default function FreeAccessProvider({ isFree, userId, children }) {
  const [open, setOpen] = useState(false);
  const [prices, setPrices] = useState(null);
  const [intent, setIntent] = useState('');
  const dialog = useRef(null);
  useEffect(() => {
    if (!isFree) return;
    let alive = true;
    let busy = false;
    const visit = async () => {
      if (document.visibilityState === 'hidden') return;
      const key = `cf-free-visit:${userId}`;
      let saved;
      try { saved = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch {}
      if (!saved || Date.now() - saved.lastSeen > 30 * 60_000) {
        saved = { id: crypto.randomUUID(), lastSeen: Date.now(), dismissed: false, reported: false };
      }
      saved.lastSeen = Date.now();
      sessionStorage.setItem(key, JSON.stringify(saved));
      // El mismo UUID ya está deduplicado en PostgreSQL. Recordarlo también en
      // la pestaña evita repetir auth + transacción cada minuto por cada usuario.
      if (saved.reported || busy) return;
      busy = true;
      try {
        const response = await fetch('/api/free/visit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visitId: saved.id }), cache: 'no-store' });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        if (!alive) return;
        saved.reported = true;
        sessionStorage.setItem(key, JSON.stringify(saved));
        if (result.paid) { window.location.reload(); return; }
        if (result.showPlans && !saved.dismissed) setOpen(true);
      } catch { /* Access never depends on a promotional modal. */ }
      finally { busy = false; }
    };
    visit();
    const timer = setInterval(visit, 60_000);
    document.addEventListener('visibilitychange', visit);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', visit); };
  }, [isFree, userId]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setIntent(crypto.randomUUID());
    fetch('/api/detect-country').then(r => r.json()).then(data => fetch(`/api/currency?country=${encodeURIComponent(data.countryCode || 'US')}`))
      .then(r => r.json()).then(data => { if (active) setPrices(data.plans); }).catch(() => {});
    const prior = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    return () => { active = false; document.body.style.overflow = overflow; prior?.focus?.(); };
  }, [open]);
  const close = () => {
    setOpen(false);
    try {
      const key = `cf-free-visit:${userId}`;
      const visit = JSON.parse(sessionStorage.getItem(key));
      if (visit) sessionStorage.setItem(key, JSON.stringify({ ...visit, dismissed: true }));
    } catch {}
  };
  const keyDown = event => {
    if (event.key === 'Escape') close();
    if (event.key !== 'Tab') return;
    const nodes = dialog.current?.querySelectorAll('a[href], button:not(:disabled)');
    if (!nodes?.length) return;
    if (event.shiftKey && (document.activeElement === nodes[0] || document.activeElement === dialog.current)) { event.preventDefault(); nodes[nodes.length - 1].focus(); }
    else if (!event.shiftKey && document.activeElement === nodes[nodes.length - 1]) { event.preventDefault(); nodes[0].focus(); }
  };
  return <AccessContext.Provider value={{ isFree, openPlans: () => setOpen(true) }}>
    <SWRConfig key={`${userId}:${isFree}`} value={{ provider: () => new Map() }}>{children}</SWRConfig>
    {isFree && open && createPortal(<div className="free-plan-overlay" onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <section className="free-plan-dialog" role="dialog" aria-modal="true" aria-labelledby="free-plan-title" tabIndex={-1} ref={dialog} onKeyDown={keyDown}>
        <button className="free-plan-close" onClick={close} aria-label="Cerrar selector de planes"><X size={20} /></button>
        <Sparkles className="free-plan-star" size={30} />
        <p className="free-plan-eyebrow">CF ANÁLISIS PRO</p><h2 id="free-plan-title">Todas las opciones. Todo el análisis.</h2>
        <p>Elige tu plan para desbloquear las recomendaciones, las frecuencias y el veredicto en los cuatro deportes.</p>
        <div className="free-plan-options">{PLANS.map(([id, name]) => {
          const p = prices?.[id];
          const amount = p ? new Intl.NumberFormat('es', { style: 'currency', currency: p.fixedCurrency ? p.nativeCurrency : p.currency || 'USD' }).format(p.fixedCurrency ? p.nativeAmount : p.local ?? p.nativeAmount ?? p.usd) : null;
          return <Link key={id} href={`/planes?checkout=${id}&intent=${encodeURIComponent(intent)}`}><strong>{name}</strong><span>{amount || 'Ver precio'} <span aria-hidden="true">→</span></span></Link>;
        })}</div>
        <button className="free-continue" onClick={close}>Continuar gratis</button>
        <small>Gratis: una opción calculada de 60–70% con cuota real por evento cuando exista. Sin tarjeta.</small>
      </section>
    </div>, document.body)}
  </AccessContext.Provider>;
}

export function UpgradeButton() {
  const { isFree, openPlans } = useFreeAccess();
  return isFree ? <button className="upgrade-pro" onClick={openPlans}><Sparkles size={15} /><span>Mejorar a Pro</span></button> : null;
}

export function LockedAnalysis({ title = 'Análisis completo' }) {
  const { openPlans } = useFreeAccess();
  return <div className="free-locked-panel">
    <div className="free-placeholder" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <div key={i}><span>Contenido exclusivo del análisis</span><b>•••</b></div>)}</div>
    <div className="free-locked-cta"><LockKeyhole size={24} /><strong>{title}</strong><button onClick={openPlans}>Actualizar plan para ver</button></div>
  </div>;
}

export function FreeRecommendations({ preview }) {
  const { openPlans } = useFreeAccess();
  const pick = preview?.selection;
  const revealed = preview?.revealed || [];
  const isFinal = !!pick?.outcome || revealed.length > 0;
  const pct = value => `${Math.floor(Number(value) * 100) / 100}%`;
  return <div className="analysis-tab-stack free-recommendations">
    <p className="probability-explainer">{isFinal
      ? 'Partido finalizado · todas las opciones ya muestran su resultado oficial.'
      : 'Tu opción gratis · probabilidad de 60–70% con cuota real.'}</p>
    {!pick && <p className="free-empty">{preview?.unavailable || 'La opción gratuita aparecerá cuando exista una probabilidad de 60–70% con cuota real.'}</p>}
    <div className="markets-grid">
      {pick && <article className={`mkt free-visible ${pick.outcome?.status === 'won' ? 'has-won' : pick.outcome?.status === 'lost' ? 'has-lost' : ''}`}><span className="mkt-name">{pick.name}</span><span className="mkt-validation is-validated">Tu recomendación gratis</span>{pick.outcome && <MarketOutcomeBadge outcome={pick.outcome} pendingLabel="Pendiente oficial" compact />}<div className="mkt-bar"><div className="mkt-fill" style={{ width: `${pick.probability}%` }} /></div><div className="mkt-nums"><strong className="mkt-pct">{pct(pick.probability)}</strong><span className="mkt-odd">@{pick.odd.toFixed(2)}</span><small>{pick.bookmaker}</small></div></article>}
      {(preview?.locked || []).map((item, index) => <button key={index} className="mkt free-hidden" onClick={openPlans} aria-label={`Ver opción Pro con probabilidad ${pct(item.probability)}`}>
        <span className="free-fake-label" aria-hidden="true">Recomendación exclusiva Pro</span><span className="free-eye"><Eye size={18} /> Ver</span><div className="mkt-bar"><div className="mkt-fill" style={{ width: `${item.probability}%` }} /></div><span className="mkt-pct">{pct(item.probability)}</span>
      </button>)}
      {revealed.map((item, index) => <article key={`${item.name}-${index}`} className={`mkt free-revealed ${item.outcome?.status === 'won' ? 'has-won' : item.outcome?.status === 'lost' ? 'has-lost' : ''}`}>
        <span className="mkt-name">{item.name}</span><span className="mkt-validation is-reference">Opción Pro revelada</span><MarketOutcomeBadge outcome={item.outcome} pendingLabel="Pendiente oficial" compact /><div className="mkt-bar"><div className="mkt-fill" style={{ width: `${item.probability}%` }} /></div><div className="mkt-nums"><strong className="mkt-pct">{pct(item.probability)}</strong><span className="mkt-odd">@{item.odd.toFixed(2)}</span><small>{item.bookmaker}</small></div>
      </article>)}
    </div>
  </div>;
}
