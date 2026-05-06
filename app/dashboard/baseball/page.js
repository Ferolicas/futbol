'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../../components/providers';
import { motion } from 'framer-motion';
import BaseballMatchCard from './components/BaseballMatchCard';
import { BASEBALL_FLAGS } from '../../../lib/baseball-leagues';

const today = () => {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return new Date().toLocaleDateString('en-CA', { timeZone: tz });
  } catch {
    return new Date().toISOString().split('T')[0];
  }
};

const detectTz = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; }
};

export default function BaseballDashboard() {
  const router = useRouter();
  const { user, supabase } = useAuth();

  const [userTz, setUserTz] = useState('UTC');
  const [date, setDate] = useState(today());
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [quota, setQuota] = useState({ used: 0, limit: 100, remaining: 100 });
  const [leagueFilter, setLeagueFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => { setUserTz(detectTz()); }, []);

  const fetchGames = useCallback(async (targetDate) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/baseball/fixtures?date=${targetDate}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch');
      setGames(data.fixtures || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchQuota = useCallback(async () => {
    try {
      const res = await fetch('/api/baseball/quota');
      const data = await res.json();
      setQuota(data);
    } catch {}
  }, []);

  useEffect(() => { fetchGames(date); fetchQuota(); }, [date, fetchGames, fetchQuota]);

  const handleToggleFavorite = useCallback(async (fixtureId) => {
    const game = games.find(g => g.id === fixtureId);
    if (!game) return;
    const newState = !game.isFavorite;
    setGames(g => g.map(x => x.id === fixtureId ? { ...x, isFavorite: newState } : x));
    try {
      await fetch('/api/baseball/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtureId, action: newState ? 'add' : 'remove' }),
      });
    } catch {
      setGames(g => g.map(x => x.id === fixtureId ? { ...x, isFavorite: !newState } : x));
    }
  }, [games]);

  const handleHide = useCallback(async (fixtureId, gameDate) => {
    setGames(g => g.map(x => x.id === fixtureId ? { ...x, isHidden: true } : x));
    try {
      await fetch('/api/baseball/hidden', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtureId, date: gameDate, action: 'hide' }),
      });
    } catch {}
  }, []);

  const handleManualRefresh = async () => {
    setRefreshing(true);
    await Promise.all([fetchGames(date), fetchQuota()]);
    setRefreshing(false);
  };

  // Group by league
  const grouped = useMemo(() => {
    const filtered = games.filter(g => {
      if (g.isHidden) return false;
      if (leagueFilter && g.league?.id !== Number(leagueFilter)) return false;
      const s = g.status?.short;
      if (statusFilter === 'live' && !['LIVE', 'IN', 'IN1', 'IN2', 'IN3', 'IN4', 'IN5', 'IN6', 'IN7', 'IN8', 'IN9'].includes(s)) return false;
      if (statusFilter === 'finished' && !['FT', 'AOT'].includes(s)) return false;
      if (statusFilter === 'upcoming' && !['NS'].includes(s)) return false;
      if (statusFilter === 'analyzed' && !g.isAnalyzed) return false;
      if (statusFilter === 'favorites' && !g.isFavorite) return false;
      return true;
    });

    const groups = {};
    for (const g of filtered) {
      const key = `${g.league?.id || 0}`;
      if (!groups[key]) {
        groups[key] = {
          leagueId: g.league?.id,
          leagueName: g.league?.name,
          country: g.country?.name || g.leagueMeta?.country || 'World',
          games: [],
        };
      }
      groups[key].games.push(g);
    }
    return Object.values(groups).sort((a, b) =>
      (a.country || '').localeCompare(b.country || '') || (a.leagueName || '').localeCompare(b.leagueName || '')
    );
  }, [games, leagueFilter, statusFilter]);

  const leagueOptions = useMemo(() => {
    const set = new Map();
    for (const g of games) {
      if (!g.league?.id) continue;
      set.set(g.league.id, { id: g.league.id, name: g.league.name, country: g.country?.name || g.leagueMeta?.country });
    }
    return Array.from(set.values()).sort((a, b) => (a.country || '').localeCompare(b.country || ''));
  }, [games]);

  const counts = useMemo(() => ({
    total: games.filter(g => !g.isHidden).length,
    live: games.filter(g => ['LIVE', 'IN', 'IN1', 'IN2', 'IN3', 'IN4', 'IN5', 'IN6', 'IN7', 'IN8', 'IN9'].includes(g.status?.short) && !g.isHidden).length,
    analyzed: games.filter(g => g.isAnalyzed && !g.isHidden).length,
    favorites: games.filter(g => g.isFavorite && !g.isHidden).length,
  }), [games]);

  const dateNav = (delta) => {
    const d = new Date(date);
    d.setDate(d.getDate() + delta);
    setDate(d.toISOString().split('T')[0]);
  };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 16px 60px', color: '#e2e8f0' }}>
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}
      >
        <h1 style={{ margin: 0, fontSize: '1.6rem', fontWeight: 800, letterSpacing: '-.5px' }}>
          ⚾ Baseball
        </h1>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{
            padding: '4px 10px', borderRadius: 999, fontSize: '.7rem', fontWeight: 700,
            background: 'rgba(245,158,11,0.1)', color: '#f59e0b',
            border: '1px solid rgba(245,158,11,0.3)',
          }}>
            API: {quota.used}/{quota.limit}
          </span>
          <button
            onClick={handleManualRefresh}
            disabled={refreshing}
            style={{
              padding: '6px 14px', borderRadius: 8, fontSize: '.78rem', fontWeight: 700,
              background: 'rgba(34,211,238,0.1)', color: '#22d3ee',
              border: '1px solid rgba(34,211,238,0.3)',
              cursor: refreshing ? 'wait' : 'pointer',
            }}
          >
            {refreshing ? '...' : '↻ Refresh'}
          </button>
        </div>
      </motion.div>

      {/* Date navigator */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <button onClick={() => dateNav(-1)} style={navBtn}>‹</button>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          style={{ ...navBtn, minWidth: 130 }}
        />
        <button onClick={() => dateNav(1)} style={navBtn}>›</button>
        <button onClick={() => setDate(today())} style={navBtn}>Hoy</button>

        <select
          value={leagueFilter}
          onChange={(e) => setLeagueFilter(e.target.value)}
          style={{ ...navBtn, minWidth: 180 }}
        >
          <option value="">Todas las ligas</option>
          {leagueOptions.map(l => (
            <option key={l.id} value={l.id}>
              {BASEBALL_FLAGS[l.country] || ''} {l.country} — {l.name}
            </option>
          ))}
        </select>
      </div>

      {/* Status filters */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {[
          { id: 'all',       label: `Todos · ${counts.total}` },
          { id: 'live',      label: `🔴 En vivo · ${counts.live}` },
          { id: 'analyzed',  label: `🎯 Analizados · ${counts.analyzed}` },
          { id: 'favorites', label: `⭐ Favoritos · ${counts.favorites}` },
          { id: 'upcoming',  label: 'Próximos' },
          { id: 'finished',  label: 'Finalizados' },
        ].map(f => (
          <button
            key={f.id}
            onClick={() => setStatusFilter(f.id)}
            style={{
              padding: '6px 12px', borderRadius: 999, fontSize: '.75rem', fontWeight: 700,
              border: '1px solid',
              background: statusFilter === f.id ? 'rgba(245,158,11,0.18)' : 'rgba(255,255,255,0.03)',
              borderColor: statusFilter === f.id ? '#f59e0b' : 'rgba(255,255,255,0.08)',
              color: statusFilter === f.id ? '#f59e0b' : '#94a3b8',
              cursor: 'pointer',
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Body */}
      {error && (
        <div style={{
          padding: 14, borderRadius: 10,
          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
          color: '#fca5a5', marginBottom: 16,
        }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>
          Cargando partidos de baseball...
        </div>
      ) : games.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>
          <div style={{ fontSize: '3rem', opacity: 0.4 }}>⚾</div>
          <p>No hay partidos de baseball en esta fecha.</p>
          <p style={{ fontSize: '.85rem', opacity: 0.7 }}>
            La temporada MLB activa va de Marzo a Octubre. Las ligas latinoamericanas (LIDOM, LVBP, LMP, LBPRC) corren de Octubre a Febrero.
          </p>
        </div>
      ) : grouped.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>
          Ningún partido coincide con los filtros.
        </div>
      ) : (
        grouped.map((g) => (
          <div key={g.leagueId} style={{ marginBottom: 24 }}>
            <h3 style={{
              fontSize: '.92rem', fontWeight: 800, color: '#cbd5e1',
              margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span>{BASEBALL_FLAGS[g.country] || '🌍'}</span>
              <span style={{ color: '#94a3b8' }}>{g.country}</span>
              <span style={{ color: '#f59e0b' }}>·</span>
              <span>{g.leagueName}</span>
              <span style={{ marginLeft: 'auto', fontSize: '.7rem', color: '#64748b', fontWeight: 600 }}>
                {g.games.length} {g.games.length === 1 ? 'partido' : 'partidos'}
              </span>
            </h3>
            <div style={{ display: 'grid', gap: 8 }}>
              {g.games.map(game => (
                <BaseballMatchCard
                  key={game.id}
                  game={game}
                  onToggleFavorite={handleToggleFavorite}
                  onHide={handleHide}
                  userTz={userTz}
                />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

const navBtn = {
  padding: '6px 12px',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  color: '#cbd5e1',
  cursor: 'pointer',
  fontSize: '.85rem',
  fontWeight: 600,
};
