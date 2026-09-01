'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, Search, SlidersHorizontal, X } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toggleSpotlightSport } from '../../../lib/spotlight-sports';
import {
  BaloncestoIcon,
  BaseballIcon,
  FutbolAmericanoIcon,
  FutbolIcon,
} from './SportIcons';

const SPORTS = [
  { key: 'football', label: 'Fútbol', path: '/dashboard', Icon: FutbolIcon },
  { key: 'baseball', label: 'Béisbol', path: '/dashboard?sport=baseball', Icon: BaseballIcon },
  { key: 'basketball', label: 'Baloncesto', path: '/dashboard?sport=basketball', Icon: BaloncestoIcon },
  { key: 'american_football', label: 'Fútbol americano', path: '/dashboard?sport=american_football', Icon: FutbolAmericanoIcon },
];

const STATUS_LABELS = {
  NS: 'Próximo', TBD: 'Por confirmar',
  FT: 'Finalizado', AET: 'Finalizado', PEN: 'Finalizado', FINAL: 'Finalizado',
  LIVE: 'En vivo', IN: 'En vivo', '1H': 'En vivo', '2H': 'En vivo', HT: 'Descanso',
  POST: 'Aplazado', PST: 'Aplazado', CANC: 'Cancelado', SUSP: 'Suspendido',
};

function resultDate(value) {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat('es-ES', {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return '';
  }
}

function scoreText(result) {
  if (result.homeScore == null || result.awayScore == null) return null;
  return `${result.homeScore} – ${result.awayScore}`;
}

export default function AppleSpotlightSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const reduceMotion = useReducedMotion();
  const inputRef = useRef(null);
  const requestRef = useRef(null);
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedSports, setSelectedSports] = useState([]);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => setMounted(true), []);

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(0);
  }, []);

  const openSearch = useCallback(() => {
    setOpen(true);
    setError('');
  }, []);

  useEffect(() => {
    const onShortcut = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (open) close();
        else openSearch();
      }
    };
    document.addEventListener('keydown', onShortcut);
    return () => document.removeEventListener('keydown', onShortcut);
  }, [close, open, openSearch]);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onEscape = (event) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onEscape);
    };
  }, [close, open]);

  useEffect(() => {
    if (!open) return undefined;
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), reduceMotion ? 0 : 160);
    return () => window.clearTimeout(focusTimer);
  }, [open, reduceMotion]);

  useEffect(() => {
    if (!open) return undefined;
    const normalizedQuery = query.trim();
    requestRef.current?.abort();

    if (normalizedQuery.length < 2) {
      setResults([]);
      setLoading(false);
      setError('');
      return undefined;
    }

    const controller = new AbortController();
    requestRef.current = controller;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams({ q: normalizedQuery });
        if (selectedSports.length) params.set('sports', selectedSports.join(','));
        const response = await fetch(`/api/dashboard-search?${params}`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'No se pudo completar la búsqueda.');
        setResults(Array.isArray(payload.results) ? payload.results : []);
        setActiveIndex(0);
      } catch (fetchError) {
        if (fetchError.name !== 'AbortError') {
          setResults([]);
          setError(fetchError.message || 'No se pudo completar la búsqueda.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 220);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, selectedSports]);

  useEffect(() => close(), [close, pathname]);

  const sportMap = useMemo(() => new Map(SPORTS.map((sport) => [sport.key, sport])), []);

  const toggleSport = (key) => {
    setSelectedSports((current) => toggleSpotlightSport(current, key));
  };

  const goTo = useCallback((href) => {
    if (!href) return;
    close();
    router.push(href);
  }, [close, router]);

  const onInputKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, Math.max(0, results.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => Math.max(0, current - 1));
    } else if (event.key === 'Enter' && results[activeIndex]) {
      event.preventDefault();
      goTo(results[activeIndex].href);
    }
  };

  const resultContent = query.trim().length < 2 ? (
    <div className="spotlight-empty">
      <Search size={27} aria-hidden="true" />
      <strong>Encuentra cualquier partido</strong>
      <span>Escribe al menos dos letras. Sin ningún deporte seleccionado, buscaremos en toda la app.</span>
      <div className="spotlight-shortcuts" aria-label="Abrir un deporte">
        {SPORTS.map(({ key, label, path, Icon }) => (
          <button key={key} type="button" onClick={() => goTo(path)}>
            <Icon size={20} />
            <span>{label}</span>
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  ) : loading ? (
    <div className="spotlight-loading" aria-live="polite">
      <span className="spotlight-spinner" aria-hidden="true" />
      Buscando en los deportes seleccionados…
    </div>
  ) : error ? (
    <div className="spotlight-message is-error" role="alert">{error}</div>
  ) : results.length === 0 ? (
    <div className="spotlight-message">
      <strong>Sin coincidencias</strong>
      <span>Prueba otro equipo, liga o activa más deportes.</span>
    </div>
  ) : (
    results.map((result, index) => {
      const sport = sportMap.get(result.sport) || SPORTS[0];
      const Icon = sport.Icon;
      const score = scoreText(result);
      const status = STATUS_LABELS[result.status] || result.statusLabel || result.status || 'Partido';
      return (
        <motion.button
          id={`spotlight-result-${index}`}
          key={`${result.sport}-${result.id}`}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={`spotlight-result ${index === activeIndex ? 'is-active' : ''}`}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => goTo(result.href)}
          initial={reduceMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduceMotion ? 0 : .18, delay: reduceMotion ? 0 : Math.min(index, 5) * .025 }}
        >
          <span className="spotlight-result-icon"><Icon size={24} /></span>
          <span className="spotlight-result-copy">
            <small>{sport.label} · {result.league || 'Competición'}</small>
            <strong>{result.homeTeam} <span>vs</span> {result.awayTeam}</strong>
            <em>{resultDate(result.kickoff)} · {status}</em>
          </span>
          <span className="spotlight-result-end">
            {score && <b>{score}</b>}
            <ArrowRight size={17} aria-hidden="true" />
          </span>
        </motion.button>
      );
    })
  );

  const overlay = (
    <AnimatePresence>
      {open && (
        <motion.div
          className="spotlight-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Buscar partidos y equipos"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : .18 }}
        >
          <button type="button" className="spotlight-page-close" onClick={close} aria-label="Cerrar búsqueda">
            <X size={20} aria-hidden="true" />
          </button>

          <motion.div
            className="spotlight-stage is-expanded"
            initial={reduceMotion ? false : { opacity: 0, y: -8, scale: .96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -5, scale: .98 }}
            transition={{ duration: reduceMotion ? 0 : .2, ease: [0.22, 1, 0.36, 1] }}
          >
            <motion.section className="spotlight-command is-expanded">
              <label className="spotlight-input-wrap">
                <Search size={22} aria-hidden="true" />
                <input
                  ref={inputRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={onInputKeyDown}
                  placeholder="Buscar"
                  aria-label="Buscar equipo, liga o partido"
                  aria-controls="spotlight-results"
                  aria-activedescendant={results[activeIndex] ? `spotlight-result-${activeIndex}` : undefined}
                  autoComplete="off"
                  enterKeyHint="search"
                />
                {query && (
                  <button type="button" className="spotlight-clear" onClick={() => setQuery('')} aria-label="Borrar búsqueda">
                    <X size={15} aria-hidden="true" />
                  </button>
                )}
              </label>

              <div className="spotlight-command-content">
                <div className="spotlight-filter-row" aria-label="Filtrar por deporte">
                  <span className="spotlight-filter-label"><SlidersHorizontal size={14} aria-hidden="true" /> Deportes</span>
                  <div className="spotlight-sports">
                    <button
                      type="button"
                      className={`spotlight-sport-chip ${selectedSports.length === 0 ? 'is-active' : ''}`}
                      onClick={() => setSelectedSports([])}
                      aria-pressed={selectedSports.length === 0}
                    >
                      Todos
                    </button>
                    {SPORTS.map(({ key, label, Icon }) => {
                      const active = selectedSports.includes(key);
                      return (
                        <button
                          key={key}
                          type="button"
                          className={`spotlight-sport-chip ${active ? 'is-active' : ''}`}
                          onClick={() => toggleSport(key)}
                          aria-pressed={active}
                        >
                          <Icon size={16} />
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="spotlight-results" id="spotlight-results" role="listbox" aria-label="Resultados de búsqueda">
                  {resultContent}
                </div>

                <footer className="spotlight-footer">
                  <span><kbd>↑</kbd><kbd>↓</kbd> navegar</span>
                  <span><kbd>↵</kbd> abrir</span>
                  <span><kbd>esc</kbd> cerrar</span>
                </footer>
              </div>
            </motion.section>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <>
      <button type="button" className="dashboard-search-trigger" onClick={openSearch} aria-label="Buscar en todos los deportes">
        <Search size={19} aria-hidden="true" />
        <span>Buscar</span>
      </button>
      {mounted ? createPortal(overlay, document.body) : null}
    </>
  );
}
