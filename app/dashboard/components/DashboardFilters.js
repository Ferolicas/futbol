'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  CalendarClock,
  Check,
  ChevronDown,
  CircleCheck,
  Clock3,
  ListFilter,
  Radio,
  RadioTower,
  Star,
  Trophy,
} from 'lucide-react';
import {
  leagueSelectionIncludes,
  normalizeLeagueSelection,
  toggleLeagueSelection,
} from '../../../lib/league-view-filter';
import {
  BaloncestoIcon,
  BaseballIcon,
  FutbolAmericanoIcon,
  FutbolIcon,
} from './SportIcons';

export const DASHBOARD_SPORTS = Object.freeze([
  { value: 'football', label: 'Fútbol', meta: 'Ligas y copas', icon: FutbolIcon },
  { value: 'baseball', label: 'Béisbol', meta: 'MLB', icon: BaseballIcon },
  { value: 'basketball', label: 'Baloncesto', meta: 'NBA y NCAA', icon: BaloncestoIcon },
  { value: 'american_football', label: 'Fútbol americano', meta: 'NFL y NCAA', icon: FutbolAmericanoIcon },
]);

function Picker({ value, onChange, options, label, placeholder, variant = 'green' }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const selected = options.find((option) => String(option.value) === String(value));

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeEscape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeEscape);
    };
  }, [open]);

  const choose = (nextValue) => {
    onChange(nextValue);
    setOpen(false);
  };

  const SelectedIcon = selected?.icon;

  return (
    <div className={`dashboard-picker is-${variant}`} ref={rootRef}>
      <button
        type="button"
        className={`dashboard-picker-trigger ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="dashboard-picker-leading">
          {selected?.logo ? (
            <img src={selected.logo} alt="" loading="lazy" decoding="async" />
          ) : SelectedIcon ? (
            <SelectedIcon size={18} aria-hidden="true" />
          ) : (
            <Trophy size={18} aria-hidden="true" />
          )}
        </span>
        <span className="dashboard-picker-copy">
          <small>{label}</small>
          <strong>{selected?.label || placeholder}</strong>
        </span>
        {selected?.count > 0 && <span className="dashboard-picker-count">{selected.count}</span>}
        <ChevronDown className="dashboard-picker-chevron" size={16} aria-hidden="true" />
      </button>

      {open && (
        <div className="dashboard-picker-menu" role="listbox" aria-label={label}>
          {options.map((option) => {
            const active = String(option.value) === String(value);
            const OptionIcon = option.icon;
            return (
              <button
                key={option.value || 'all'}
                type="button"
                className={active ? 'is-active' : ''}
                onClick={() => choose(option.value)}
                role="option"
                aria-selected={active}
              >
                <span className="dashboard-picker-option-icon">
                  {option.logo ? (
                    <img src={option.logo} alt="" loading="lazy" decoding="async" />
                  ) : OptionIcon ? (
                    <OptionIcon size={17} aria-hidden="true" />
                  ) : (
                    <Trophy size={17} aria-hidden="true" />
                  )}
                </span>
                <span>
                  <strong>{option.label}</strong>
                  {option.meta && <small>{option.meta}</small>}
                </span>
                {option.count > 0 && <span className="dashboard-picker-option-count">{option.count}</span>}
                {active && <Check size={15} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function LeaguePicker({
  leagues,
  value,
  onChange,
  variant = 'green',
  multiple = false,
  allLeagueIds = [],
  disabled = false,
  saving = false,
}) {
  if (!multiple) {
    const options = [
      { value: '', label: 'Todas las ligas', meta: 'Sin limitar competiciones', icon: Trophy },
      ...leagues.map((league) => ({
        value: String(league.id),
        label: league.name,
        meta: league.country || 'Competición',
        logo: league.logo,
      })),
    ];

    return (
      <Picker
        value={value}
        onChange={onChange}
        options={options}
        label="Competición"
        placeholder="Todas las ligas"
        variant={variant}
      />
    );
  }

  return (
    <MultiLeaguePicker
      leagues={leagues}
      value={value}
      onChange={onChange}
      variant={variant}
      allLeagueIds={allLeagueIds}
      disabled={disabled}
      saving={saving}
    />
  );
}

export function SportPicker({ value, onChange, variant = 'green' }) {
  const changeSport = (nextSport) => {
    if (onChange) {
      onChange(nextSport);
      return;
    }
    const destination = nextSport === 'football' ? '/dashboard' : `/dashboard?sport=${nextSport}`;
    window.location.assign(destination);
  };
  return (
    <Picker
      value={value}
      onChange={changeSport}
      options={DASHBOARD_SPORTS}
      label="Deporte"
      placeholder="Fútbol"
      variant={variant}
    />
  );
}

function MultiLeaguePicker({ leagues, value, onChange, variant, allLeagueIds, disabled, saving }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const normalized = useMemo(() => normalizeLeagueSelection(value), [value]);
  const selectedSet = useMemo(() => new Set(normalized || []), [normalized]);
  const availableSelected = normalized === null
    ? leagues.length
    : leagues.filter(league => selectedSet.has(String(league.id))).length;
  const singleLeague = availableSelected === 1
    ? leagues.find(league => leagueSelectionIncludes(normalized, league.id))
    : null;
  const summary = disabled
    ? 'Cargando ligas…'
    : normalized === null
      ? 'Todas las ligas'
      : normalized.length === 0
        ? 'Ninguna liga'
        : singleLeague?.name || `${availableSelected} ligas visibles`;

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeEscape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeEscape);
    };
  }, [open]);

  const toggle = (leagueId) => {
    const knownIds = allLeagueIds.length > 0
      ? allLeagueIds
      : leagues.map(league => String(league.id));
    onChange(toggleLeagueSelection(normalized, leagueId, knownIds));
  };

  return (
    <div className={`dashboard-picker league-multi-picker is-${variant}`} ref={rootRef}>
      <button
        type="button"
        className={`dashboard-picker-trigger ${open ? 'is-open' : ''}`}
        onClick={() => setOpen(current => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
      >
        <span className="dashboard-picker-leading">
          {singleLeague?.logo ? (
            <img src={singleLeague.logo} alt="" loading="lazy" decoding="async" />
          ) : (
            <Trophy size={18} aria-hidden="true" />
          )}
        </span>
        <span className="dashboard-picker-copy">
          <small>Competición</small>
          <strong>{summary}</strong>
        </span>
        {!disabled && <span className="dashboard-picker-count">{availableSelected}</span>}
        <ChevronDown className="dashboard-picker-chevron" size={16} aria-hidden="true" />
      </button>

      {open && !disabled && (
        <div className="dashboard-picker-menu league-multi-menu" role="group" aria-label="Filtrar ligas visibles">
          <div className="league-picker-actions">
            <button type="button" onClick={() => onChange(null)}>Todas</button>
            <button type="button" onClick={() => onChange([])}>Ninguna</button>
            <span aria-live="polite">{saving ? 'Guardando…' : `${availableSelected}/${leagues.length} visibles`}</span>
          </div>
          <div className="league-picker-list">
            {leagues.map((league) => {
              const checked = leagueSelectionIncludes(normalized, league.id);
              return (
                <label key={league.id} className={checked ? 'is-active' : ''}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(league.id)}
                  />
                  <span className="league-checkbox" aria-hidden="true">
                    {checked && <Check size={13} />}
                  </span>
                  <span className="dashboard-picker-option-icon">
                    {league.logo ? (
                      <img src={league.logo} alt="" loading="lazy" decoding="async" />
                    ) : (
                      <Trophy size={17} aria-hidden="true" />
                    )}
                  </span>
                  <span className="league-picker-option-copy">
                    <strong>{league.name}</strong>
                    <small>{league.country || 'Competición'}</small>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function StatusPicker({ value, onChange, counts = {}, variant = 'green', includeFavorites = true }) {
  const options = [
    { value: 'all', label: 'Todos', meta: 'Vista completa', icon: ListFilter, count: counts.all },
    { value: 'live', label: 'En vivo', meta: 'Ahora mismo', icon: Radio, count: counts.live },
    { value: 'upcoming', label: 'Próximos', meta: 'Por comenzar', icon: Clock3, count: counts.upcoming },
    { value: 'finished', label: 'Finalizados', meta: 'Resultados cerrados', icon: CircleCheck, count: counts.finished },
    ...(includeFavorites
      ? [{ value: 'favoritos', label: 'Favoritos', meta: 'Tus guardados', icon: Star, count: counts.favorites }]
      : []),
  ];

  return (
    <Picker
      value={value}
      onChange={onChange}
      options={options}
      label="Estado"
      placeholder="Todos"
      variant={variant}
    />
  );
}

export function DateCaption({ isToday, label }) {
  return (
    <span className="dashboard-date-caption">
      <CalendarClock size={17} aria-hidden="true" />
      <span>
        <small>Jornada</small>
        <strong className={isToday ? 'is-today' : ''}>{isToday ? 'Hoy' : label}</strong>
      </span>
    </span>
  );
}

const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function shiftIsoDay(date, amount) {
  const [year, month, day] = String(date).split('-').map(Number);
  const shifted = new Date(year, month - 1, day + amount, 12);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;
}

function compactDay(date) {
  const [year, month, day] = String(date).split('-').map(Number);
  const value = new Date(year, month - 1, day, 12);
  return {
    weekday: WEEKDAYS[value.getDay()],
    calendar: `${value.getDate()} ${MONTHS[value.getMonth()]}`,
  };
}

/** Mañana, hoy y los diez días anteriores, en ese orden. */
export function DashboardDateStrip({ today, value, onChange }) {
  const dates = useMemo(
    () => Array.from({ length: 12 }, (_, index) => shiftIsoDay(today, 1 - index)),
    [today],
  );

  return (
    <nav className="dashboard-date-strip" aria-label="Elegir jornada">
      <div className="dashboard-date-track">
        {dates.map((date) => {
          const label = compactDay(date);
          const isToday = date === today;
          const isSelected = date === value;
          return (
            <button
              key={date}
              type="button"
              className={`dashboard-date-tile ${isToday ? 'is-today' : ''} ${isSelected ? 'is-selected' : ''}`}
              data-selected={isSelected ? 'true' : 'false'}
              onClick={() => onChange(date)}
              aria-current={isSelected ? 'date' : undefined}
              aria-label={`${isToday ? 'Hoy, ' : ''}${label.weekday} ${label.calendar}`}
            >
              <span>{label.weekday}</span>
              <strong>{label.calendar}</strong>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export function DashboardStatusDock({ value, onChange, counts = {}, isToday, onToday }) {
  const items = [
    { key: 'today', label: 'Hoy', icon: CalendarDays, count: counts.all },
    { key: 'upcoming', label: 'Próximos', icon: Clock3, count: counts.upcoming },
    { key: 'live', label: 'En vivo', icon: RadioTower, count: counts.live, live: true },
    { key: 'finished', label: 'Finalizados', icon: CircleCheck, count: counts.finished },
    { key: 'favoritos', label: 'Favoritos', icon: Star, count: counts.favorites },
  ];

  const select = (key) => {
    if (key === 'today') {
      onToday();
      onChange('all');
      return;
    }
    onChange(key);
  };

  return (
    <nav className="dashboard-status-dock" aria-label="Filtrar partidos por estado">
      <span className="dashboard-status-live-bulge" aria-hidden="true" />
      {items.map((item) => {
        const Icon = item.icon;
        const active = item.key === 'today' ? (isToday && value === 'all') : value === item.key;
        return (
          <button
            key={item.key}
            type="button"
            className={`dashboard-status-item ${item.live ? 'is-live' : ''} ${active ? 'is-active' : ''}`}
            onClick={() => select(item.key)}
            aria-pressed={active}
          >
            <span className="dashboard-status-icon">
              {item.live && <i className="dashboard-live-pulse" aria-hidden="true" />}
              <Icon size={item.live ? 25 : 21} aria-hidden="true" />
              {Number(item.count) > 0 && <b>{item.count > 99 ? '99+' : item.count}</b>}
            </span>
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
