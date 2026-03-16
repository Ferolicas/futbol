'use client';

import { useState, useEffect, useRef } from 'react';

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
      </div>

      {tab === 'chat' && <ChatSection />}
      {tab === 'tickets' && <TicketsSection />}
    </div>
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
