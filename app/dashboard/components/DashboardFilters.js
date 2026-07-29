'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CalendarClock,
  Check,
  ChevronDown,
  CircleCheck,
  Clock3,
  ListFilter,
  Radio,
  Star,
  Trophy,
} from 'lucide-react';

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

export function LeaguePicker({ leagues, value, onChange, variant = 'green' }) {
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

export function StatusPicker({ value, onChange, counts = {}, variant = 'green' }) {
  const options = [
    { value: 'all', label: 'Todos', meta: 'Vista completa', icon: ListFilter, count: counts.all },
    { value: 'live', label: 'En vivo', meta: 'Ahora mismo', icon: Radio, count: counts.live },
    { value: 'upcoming', label: 'Próximos', meta: 'Por comenzar', icon: Clock3, count: counts.upcoming },
    { value: 'finished', label: 'Finalizados', meta: 'Resultados cerrados', icon: CircleCheck, count: counts.finished },
    { value: 'favoritos', label: 'Favoritos', meta: 'Tus guardados', icon: Star, count: counts.favorites },
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
