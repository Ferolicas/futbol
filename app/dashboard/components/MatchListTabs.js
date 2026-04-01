'use client';

const TABS = [
  { id: 'all',      label: 'Todos',      icon: '📋' },
  { id: 'live',     label: 'En Vivo',    icon: '🔴', liveIndicator: true },
  { id: 'favorites', label: 'Favoritos', icon: '⭐' },
  { id: 'finished', label: 'Finalizados', icon: '✅' },
];

export default function MatchListTabs({ activeTab, onChange, counts = {} }) {
  return (
    <div className="tabs-bar" role="tablist">
      {TABS.map(tab => {
        const count = counts[tab.id] ?? 0;
        const isActive = activeTab === tab.id;

        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            className={`tab-btn${isActive ? ' active' : ''}`}
            onClick={() => onChange(tab.id)}
          >
            <span>{tab.icon}</span>
            <span className="hidden-xs">{tab.label}</span>
            {count > 0 && (
              <span className="tab-count">
                {tab.id === 'live' && count > 0 ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    <span className="live-dot" style={{ width: 5, height: 5 }} />
                    {count}
                  </span>
                ) : count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
