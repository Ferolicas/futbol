'use client';

import { useEffect, useState } from 'react';
import { BellRing, Check, Trash2, X } from 'lucide-react';
import {
  ALL_FOOTBALL_NOTIFICATION_PREFERENCES,
  FOOTBALL_NOTIFICATION_OPTIONS,
  normalizeFootballNotificationPreferences,
} from '../../../lib/football-notification-preferences';

export default function FavoriteNotificationSheet({
  isFavorite,
  matchLabel,
  initialPreferences,
  saving,
  onClose,
  onSave,
  onRemove,
}) {
  const [selected, setSelected] = useState(() => normalizeFootballNotificationPreferences(initialPreferences));

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, saving]);

  const toggle = (key) => {
    setSelected((current) => current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key]);
  };

  return (
    <div className="favorite-notification-overlay" role="presentation" onMouseDown={() => !saving && onClose()}>
      <section
        className="favorite-notification-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="favorite-notification-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="favorite-notification-close" onClick={onClose} disabled={saving} aria-label="Cerrar">
          <X size={18} />
        </button>

        <header>
          <span><BellRing size={19} /></span>
          <div>
            <small>PARTIDO FAVORITO</small>
            <h2 id="favorite-notification-title">Notificaciones</h2>
          </div>
        </header>
        <p>Elige qué quieres recibir de <strong>{matchLabel}</strong>.</p>

        <div className="favorite-notification-presets" aria-label="Selección rápida">
          <button type="button" onClick={() => setSelected([...ALL_FOOTBALL_NOTIFICATION_PREFERENCES])} disabled={saving}>Todos</button>
          <button type="button" onClick={() => setSelected([])} disabled={saving}>Ninguno</button>
        </div>

        <div className="favorite-notification-options">
          {FOOTBALL_NOTIFICATION_OPTIONS.map((option) => {
            const active = selected.includes(option.key);
            return (
              <button
                type="button"
                key={option.key}
                className={active ? 'is-selected' : ''}
                aria-pressed={active}
                onClick={() => toggle(option.key)}
                disabled={saving}
              >
                <span aria-hidden="true">{option.icon}</span>
                <strong>{option.label}</strong>
                <i aria-hidden="true">{active && <Check size={13} strokeWidth={3} />}</i>
              </button>
            );
          })}
        </div>

        <p className="favorite-notification-summary">
          {selected.length === 0
            ? 'El partido quedará guardado sin enviar avisos.'
            : `${selected.length} ${selected.length === 1 ? 'tipo de aviso seleccionado' : 'tipos de aviso seleccionados'}.`}
        </p>

        <div className="favorite-notification-actions">
          {isFavorite && (
            <button type="button" className="favorite-notification-remove" onClick={onRemove} disabled={saving}>
              <Trash2 size={15} /> Quitar favorito
            </button>
          )}
          <button type="button" className="favorite-notification-save" onClick={() => onSave(selected)} disabled={saving}>
            {saving ? 'Guardando…' : (isFavorite ? 'Guardar cambios' : 'Guardar favorito')}
          </button>
        </div>
      </section>
    </div>
  );
}
