'use client';

import { useState, useEffect, useRef } from 'react';
import MarketOutcomeBadge from '../dashboard/components/MarketOutcomeBadge';

export default function AdminPanel() {
  const [tab, setTab] = useState('chat');

  return (
    <div>
      <div className="admin-tabs">
        <button className={`admin-tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>
          Chat en Vivo
        </button>
        <button className={`admin-tab ${tab === 'tickets' ? 'active' : ''}`} onClick={() => setTab('tickets')}>
          Tickets
        </button>
        <button className={`admin-tab ${tab === 'activos' ? 'active' : ''}`} onClick={() => setTab('activos')}>
          Clientes Activos
        </button>
        <button className={`admin-tab ${tab === 'pendientes' ? 'active' : ''}`} onClick={() => setTab('pendientes')}>
          Clientes Pendientes
        </button>
        <button className={`admin-tab ${tab === 'resultados' ? 'active' : ''}`} onClick={() => setTab('resultados')}>
          Aciertos del día
        </button>
      </div>

      {tab === 'chat' && <ChatSection />}
      {tab === 'tickets' && <TicketsSection />}
      {tab === 'activos' && <ActiveClientsSection />}
      {tab === 'pendientes' && <PendingClientsSection />}
      {tab === 'resultados' && <DailyResultsSection />}
    </div>
  );
}

/* ── DAILY PICK RESULTS ── */
function localIsoDate() {
  try { return new Date().toLocaleDateString('en-CA'); }
  catch { return new Date().toISOString().slice(0, 10); }
}

function HitsCurve({ points = [] }) {
  const width = 760;
  const height = 230;
  const padX = 42;
  const padTop = 24;
  const padBottom = 42;
  const usableWidth = width - padX * 2;
  const usableHeight = height - padTop - padBottom;
  const safePoints = points.length > 1 ? points : [{ label: 'Inicio', won: 0 }, { label: 'Ahora', won: points[0]?.won || 0 }];
  const maxWon = Math.max(1, ...safePoints.map((point) => Number(point.won) || 0));
  const coordinates = safePoints.map((point, index) => ({
    ...point,
    x: padX + (usableWidth * index / Math.max(1, safePoints.length - 1)),
    y: padTop + usableHeight - ((Number(point.won) || 0) / maxWon * usableHeight),
  }));
  const line = coordinates.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
  const area = `${line} L ${coordinates.at(-1).x} ${padTop + usableHeight} L ${coordinates[0].x} ${padTop + usableHeight} Z`;
  const labelStep = Math.max(1, Math.ceil(coordinates.length / 6));

  return (
    <div className="admin-hits-chart" role="img" aria-label={`Curva acumulada con ${coordinates.at(-1)?.won || 0} aciertos`}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="adminHitsArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#5ee6b1" stopOpacity=".35" />
            <stop offset="1" stopColor="#5ee6b1" stopOpacity="0" />
          </linearGradient>
          <filter id="adminHitsGlow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {[0, .25, .5, .75, 1].map((ratio) => (
          <line key={ratio} x1={padX} x2={width - padX} y1={padTop + usableHeight * ratio} y2={padTop + usableHeight * ratio} className="admin-chart-grid" />
        ))}
        <path d={area} fill="url(#adminHitsArea)" />
        <path d={line} className="admin-chart-line" filter="url(#adminHitsGlow)" />
        {coordinates.map((point, index) => (
          <g key={`${point.fixtureId || 'point'}-${index}`}>
            <circle cx={point.x} cy={point.y} r="4.5" className="admin-chart-dot" />
            {(index === 0 || index === coordinates.length - 1 || index % labelStep === 0) && (
              <text x={point.x} y={height - 14} textAnchor="middle" className="admin-chart-label">{point.label}</text>
            )}
          </g>
        ))}
        <text x="12" y={padTop + 5} className="admin-chart-axis">{maxWon}</text>
        <text x="18" y={padTop + usableHeight + 4} className="admin-chart-axis">0</text>
      </svg>
    </div>
  );
}

function DailyResultsSection() {
  const [date, setDate] = useState(localIsoDate);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let running = false;
    const timeZone = (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Madrid'; }
      catch { return 'Europe/Madrid'; }
    })();
    const load = async () => {
      if (running) return;
      running = true;
      try {
        const response = await fetch(`/api/admin/daily-pick-results?date=${date}&tz=${encodeURIComponent(timeZone)}`, { cache: 'no-store' });
        const json = await response.json();
        if (!response.ok) throw new Error(json.error || 'No se pudieron cargar los resultados');
        if (!cancelled) { setData(json); setError(''); }
      } catch (requestError) {
        if (!cancelled) setError(requestError.message || 'No se pudieron cargar los resultados');
      } finally {
        running = false;
        if (!cancelled) setLoading(false);
      }
    };
    setLoading(true);
    load();
    const interval = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [date]);

  const totals = data?.totals || { won: 0, lost: 0, pending: 0, total: 0, accuracy: 0 };
  return (
    <section className="admin-daily-results">
      <header className="admin-results-heading">
        <div>
          <small>Seguimiento oficial · actualización cada 30 segundos</small>
          <h2>Aciertos de la apuesta del día</h2>
        </div>
        <label>
          <span>Jornada</span>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
      </header>

      {error && <div className="warn" role="alert">{error}</div>}
      {loading && !data ? <p className="admin-results-loading">Cargando resultados oficiales…</p> : (
        <>
          <div className="admin-results-metrics">
            <article className="is-won"><small>Ganadas</small><strong>{totals.won}</strong></article>
            <article className="is-lost"><small>Perdidas</small><strong>{totals.lost}</strong></article>
            <article><small>En juego / pendientes</small><strong>{totals.pending}</strong></article>
            <article className="is-accuracy"><small>Porcentaje de acierto</small><strong>{totals.accuracy}%</strong></article>
          </div>

          <div className="admin-results-chart-card">
            <div className="admin-results-chart-title">
              <span><small>Curva acumulada</small><strong>{totals.won} aciertos confirmados</strong></span>
              <em>{data?.updatedAt ? `Actualizado ${fmtTime(data.updatedAt)}` : ''}</em>
            </div>
            <HitsCurve points={data?.curve || []} />
          </div>

          <div className="admin-result-match-list">
            {(data?.matches || []).length === 0 && (
              <div className="admin-results-empty">Todavía no hay partidos en vivo o finalizados con opciones de la apuesta del día.</div>
            )}
            {(data?.matches || []).map((match) => {
              const matchWon = match.selections.filter((selection) => selection.outcome.status === 'won').length;
              const matchLost = match.selections.filter((selection) => selection.outcome.status === 'lost').length;
              return (
                <article className="admin-result-match" key={`${match.sport}-${match.fixtureId}`}>
                  <header>
                    <span><small>{match.sport} · {match.league || 'Competición'}</small><strong>{match.matchName}</strong></span>
                    <span className={match.isLive ? 'is-live' : 'is-final'}>{match.isLive ? 'EN VIVO' : 'FINALIZADO'}</span>
                  </header>
                  <div className="admin-result-match-summary">
                    <b className="is-won">{matchWon} ganadas</b>
                    <b className="is-lost">{matchLost} perdidas</b>
                  </div>
                  <div className="admin-result-selections">
                    {match.selections.map((selection, index) => (
                      <div key={`${selection.id || 'selection'}-${index}`}>
                        <span><strong>{selection.name}</strong><small>{selection.probability}% · @{Number(selection.odd).toFixed(2)}</small></span>
                        <MarketOutcomeBadge
                          outcome={selection.outcome}
                          pendingLabel={match.isLive ? 'En juego' : null}
                          compact
                        />
                      </div>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

/* ── CHAT SECTION ── */
function ChatSection() {
  const [conversations, setConversations] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const messagesEndRef = useRef(null);
  const pollRef = useRef(null);

  useEffect(() => {
    loadConversations();
    const iv = setInterval(loadConversations, 10000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (selectedUser) {
      loadUserMessages(selectedUser);
      pollRef.current = setInterval(() => loadUserMessages(selectedUser), 5000);
      return () => clearInterval(pollRef.current);
    }
  }, [selectedUser]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const loadConversations = async () => {
    try {
      const res = await fetch('/api/chat');
      const data = await res.json();
      if (data.conversations) setConversations(data.conversations);
    } catch {}
    setLoading(false);
  };

  const loadUserMessages = async (userId) => {
    try {
      const res = await fetch(`/api/chat?userId=${userId}`);
      const data = await res.json();
      if (data.messages) setMessages(data.messages);
    } catch {}
  };

  const sendReply = async () => {
    if (!input.trim() || !selectedUser || sending) return;
    setSending(true);
    const text = input;
    setInput('');

    setMessages(prev => [...prev, {
      _id: 'temp-' + Date.now(),
      message: text,
      sender: 'agent',
      createdAt: new Date().toISOString(),
    }]);

    try {
      await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, targetUserId: selectedUser }),
      });
      loadUserMessages(selectedUser);
    } catch {}
    setSending(false);
  };

  if (loading) return <p style={{ color: 'var(--t2)', padding: '20px' }}>Cargando chats...</p>;

  return (
    <div className="admin-chat-panel">
      {/* Conversation list */}
      <div className="admin-chat-sidebar">
        <h3 className="admin-section-title">Conversaciones ({conversations.length})</h3>
        <div className="admin-chat-list">
          {conversations.length === 0 && (
            <p style={{ color: 'var(--t3)', fontSize: '.85rem', padding: '12px' }}>Sin conversaciones</p>
          )}
          {conversations.map(conv => (
            <div
              key={conv.userId}
              className={`admin-chat-item ${conv.unreadCount > 0 ? 'unread' : ''} ${selectedUser === conv.userId ? 'active' : ''}`}
              onClick={() => setSelectedUser(conv.userId)}
            >
              <div>
                <div className="admin-chat-user">{conv.userName}</div>
                <div className="admin-chat-preview">
                  {conv.lastMessage?.message?.slice(0, 50)}
                  {conv.lastMessage?.message?.length > 50 ? '...' : ''}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="admin-chat-time">{fmtTime(conv.lastMessage?.createdAt)}</div>
                {conv.unreadCount > 0 && (
                  <span className="admin-unread-badge">{conv.unreadCount}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Chat area */}
      <div className="admin-chat-area">
        {!selectedUser ? (
          <div className="admin-chat-empty">Selecciona una conversacion</div>
        ) : (
          <>
            <div className="admin-chat-header">
              <span className="admin-chat-header-name">
                {conversations.find(c => c.userId === selectedUser)?.userName || 'Chat'}
              </span>
              <span className="admin-chat-header-email">
                {conversations.find(c => c.userId === selectedUser)?.userEmail}
              </span>
            </div>
            <div className="chat-messages" style={{ flex: 1, maxHeight: '50vh' }}>
              {messages.map(msg => (
                <div key={msg._id} className={`chat-msg ${msg.sender}`}>
                  <div>{msg.message}</div>
                  <div className="chat-msg-time">{fmtTime(msg.createdAt)}</div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
            <div className="chat-input-bar">
              <input
                className="chat-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendReply(); } }}
                placeholder="Responder..."
              />
              <button className="chat-send" onClick={sendReply} disabled={sending}>Enviar</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── TICKETS SECTION ── */
function TicketsSection() {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [replyInputs, setReplyInputs] = useState({});
  const [replying, setReplying] = useState(null);

  useEffect(() => {
    loadTickets();
    const iv = setInterval(loadTickets, 15000);
    return () => clearInterval(iv);
  }, []);

  const loadTickets = async () => {
    try {
      const res = await fetch('/api/tickets');
      const data = await res.json();
      if (data.tickets) setTickets(data.tickets);
    } catch {}
    setLoading(false);
  };

  const sendReply = async (ticket) => {
    const docId = ticket._id?.replace('cfaTicket-', '');
    const reply = replyInputs[docId];
    if (!reply?.trim() || !docId) return;

    setReplying(docId);
    try {
      await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketDocId: docId, reply }),
      });
      setReplyInputs(prev => ({ ...prev, [docId]: '' }));
      loadTickets();
    } catch {}
    setReplying(null);
  };

  if (loading) return <p style={{ color: 'var(--t2)', padding: '20px' }}>Cargando tickets...</p>;

  const openTickets = tickets.filter(t => t.status === 'open');
  const closedTickets = tickets.filter(t => t.status !== 'open');

  return (
    <div className="admin-tickets-panel">
      <h3 className="admin-section-title">
        Tickets ({tickets.length})
        {openTickets.length > 0 && (
          <span className="admin-open-count">{openTickets.length} abiertos</span>
        )}
      </h3>

      {tickets.length === 0 && (
        <p style={{ color: 'var(--t3)', padding: '12px' }}>Sin tickets</p>
      )}

      <div className="admin-ticket-list">
        {/* Open tickets first */}
        {openTickets.map(ticket => (
          <TicketCard
            key={ticket._id}
            ticket={ticket}
            replyInputs={replyInputs}
            setReplyInputs={setReplyInputs}
            sendReply={sendReply}
            replying={replying}
          />
        ))}
        {/* Then closed */}
        {closedTickets.map(ticket => (
          <TicketCard
            key={ticket._id}
            ticket={ticket}
            replyInputs={replyInputs}
            setReplyInputs={setReplyInputs}
            sendReply={sendReply}
            replying={replying}
          />
        ))}
      </div>
    </div>
  );
}

function TicketCard({ ticket, replyInputs, setReplyInputs, sendReply, replying }) {
  const docId = ticket._id?.replace('cfaTicket-', '');

  return (
    <div className={`admin-ticket ${ticket.status === 'open' ? 'open' : 'closed'}`}>
      <div className="admin-ticket-top">
        <span className="admin-ticket-id">{ticket.ticketId}</span>
        <span className={`admin-ticket-status ${ticket.status}`}>
          {ticket.status === 'open' ? 'ABIERTO' : 'RESPONDIDO'}
        </span>
      </div>
      <div className="admin-ticket-msg">{ticket.message}</div>
      <div className="admin-ticket-meta">
        <span>{ticket.userName} ({ticket.userEmail})</span>
        <span>{fmtDate(ticket.createdAt)}</span>
      </div>

      {ticket.reply && (
        <div className="admin-ticket-reply">
          <div className="admin-ticket-reply-label">Respuesta:</div>
          <div className="admin-ticket-reply-text">{ticket.reply}</div>
          <div className="admin-ticket-reply-time">{fmtDate(ticket.repliedAt)}</div>
        </div>
      )}

      {ticket.status === 'open' && (
        <div className="admin-reply-box">
          <input
            value={replyInputs[docId] || ''}
            onChange={(e) => setReplyInputs(prev => ({ ...prev, [docId]: e.target.value }))}
            onKeyDown={(e) => { if (e.key === 'Enter') sendReply(ticket); }}
            placeholder="Escribir respuesta..."
          />
          <button
            className="admin-reply-btn"
            onClick={() => sendReply(ticket)}
            disabled={replying === docId}
          >
            {replying === docId ? '...' : 'Responder'}
          </button>
        </div>
      )}
    </div>
  );
}

/* ── CLIENTS SECTIONS ── */
function useClients(refreshMs = 15000) {
  const [data, setData] = useState({ active: [], pending: [], counts: { active: 0, pending: 0 } });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/admin/clients', { cache: 'no-store' });
        const json = await res.json();
        if (!cancelled && json.active) setData(json);
      } catch {}
      if (!cancelled) setLoading(false);
    };
    load();
    const iv = setInterval(load, refreshMs);
    return () => { cancelled = true; clearInterval(iv); };
  }, [refreshMs]);

  return { ...data, loading };
}

function ActiveClientsSection() {
  const { active, loading } = useClients(15000);
  if (loading) return <p style={{ color: 'var(--t2)', padding: '20px' }}>Cargando clientes...</p>;

  return (
    <div className="admin-tickets-panel">
      <h3 className="admin-section-title">Clientes Activos ({active.length})</h3>
      {active.length === 0 && <p style={{ color: 'var(--t3)', padding: '12px' }}>Sin clientes activos</p>}
      <div className="admin-ticket-list">
        {active.map(c => (
          <div key={c.id} className="admin-ticket open">
            <div className="admin-ticket-top">
              <span className="admin-ticket-id">{c.name || '(sin nombre)'}</span>
              <span className={`admin-ticket-status ${c.role === 'admin' || c.role === 'owner' ? 'open' : 'closed'}`}>
                {c.role === 'admin' || c.role === 'owner' ? 'ADMIN' : (c.plan || '').toUpperCase()}
              </span>
            </div>
            <div className="admin-ticket-meta">
              <span>{c.email}</span>
              <span>Registro: {fmtDate(c.created_at)}</span>
            </div>
            <div className="admin-ticket-meta">
              <span>Último pago: {c.last_payment_at ? fmtDate(c.last_payment_at) : '—'}</span>
              <span style={{ color: c.next_payment_at ? 'var(--accent)' : 'var(--t3)', fontWeight: 600 }}>
                Siguiente pago: {c.next_payment_at ? fmtDate(c.next_payment_at) : '—'}
              </span>
            </div>
            {c.last_payment_amount != null && (
              <div className="admin-ticket-meta">
                <span>
                  Monto: {(c.payment_provider === 'mercadopago'
                    ? Number(c.last_payment_amount)
                    : Number(c.last_payment_amount) / 100).toLocaleString('es-ES', { maximumFractionDigits: 2 })}{' '}
                  {(c.last_payment_currency || '').toUpperCase()}
                </span>
                <span>{c.payment_provider === 'mercadopago' ? 'Mercado Pago' : `Estado Stripe: ${c.stripe_status || '—'}`}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PendingClientsSection() {
  const { pending, loading } = useClients(15000);
  if (loading) return <p style={{ color: 'var(--t2)', padding: '20px' }}>Cargando clientes...</p>;

  return (
    <div className="admin-tickets-panel">
      <h3 className="admin-section-title">Clientes Pendientes ({pending.length})</h3>
      {pending.length === 0 && <p style={{ color: 'var(--t3)', padding: '12px' }}>Sin clientes pendientes</p>}
      <div className="admin-ticket-list">
        {pending.map(c => (
          <div key={c.id} className="admin-ticket closed">
            <div className="admin-ticket-top">
              <span className="admin-ticket-id">{c.name || '(sin nombre)'}</span>
              <span className="admin-ticket-status closed">
                {(c.subscription_status || 'sin pago').toUpperCase()}
              </span>
            </div>
            <div className="admin-ticket-meta">
              <span>{c.email}</span>
              <span>Registrado: {fmtDate(c.created_at)}</span>
            </div>
            {c.stripe_customer_id && (
              <div className="admin-ticket-meta">
                <span style={{ color: 'var(--t3)', fontSize: '0.8rem' }}>
                  Stripe: {c.stripe_customer_id} (sin pago confirmado)
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── HELPER FUNCTIONS ── */
function fmtTime(d) {
  if (!d) return '';
  const date = new Date(d);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' ' +
    date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('es', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
