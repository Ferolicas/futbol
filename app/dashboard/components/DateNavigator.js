'use client';
import { fmtDateDisplay, todayInTz } from '../../../lib/timezone';

export default function DateNavigator({ date, onPrev, onNext, userTz = 'UTC' }) {
  const today = todayInTz(userTz);
  const isToday = date === today;
  const displayDate = isToday ? 'Hoy' : fmtDateDisplay(date, userTz);

  return (
    <div className="date-nav">
      <button className="date-nav-btn" onClick={onPrev} aria-label="Día anterior">‹</button>
      <span className="date-nav-label" style={isToday ? { color: 'var(--accent-cyan)' } : {}}>
        {displayDate}
      </span>
      <button className="date-nav-btn" onClick={onNext} aria-label="Día siguiente">›</button>
    </div>
  );
}
