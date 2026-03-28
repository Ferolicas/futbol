'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { usePusherEvent } from '../../lib/use-pusher';

export default function ChatWidget() {
  const { data: session } = useSession();
  const user = session?.user;
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState('menu'); // 'menu', 'ticket', 'chat', 'ticket-sent'
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [ticketInput, setTicketInput] = useState('');
  const [ticketId, setTicketId] = useState('');
  const [sending, setSending] = useState(false);
  const [unread, setUnread] = useState(0);
  const messagesEndRef = useRef(null);
  const pollRef = useRef(null);

  // Real-time chat messages via Pusher (use Sanity _id as channel identifier)
  usePusherEvent(
    user?.id ? `chat-${user.id}` : null,
    'new-message',
    useCallback((msg) => {
      setMessages(prev => {
        if (prev.some(m => m._id === msg._id)) return prev;
        return [...prev, msg];
      });
      if (msg.sender === 'agent') setUnread(prev => prev + 1);
    }, [])
  );

  // Load messages when chat opens (initial load + fallback polling)
  useEffect(() => {
    if (isOpen && view === 'chat' && user) {
      loadMessages();
      pollRef.current = setInterval(loadMessages, 30000);
      return () => clearInterval(pollRef.current);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [isOpen, view, user]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const loadMessages = async () => {
    try {
      const res = await fetch('/api/chat');
      const data = await res.json();
      if (data.messages) {
        setMessages(data.messages);
        const newUnread = data.messages.filter(m => m.sender === 'agent' && !m.read).length;
        setUnread(newUnread);
      }
    } catch {}
  };

  const sendMessage = async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    const text = input;
    setInput('');

    setMessages(prev => [...prev, {
      _id: 'temp-' + Date.now(),
      message: text,
      sender: 'user',
      createdAt: new Date().toISOString(),
    }]);

    try {
      await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      loadMessages();
    } catch {}
    setSending(false);
  };

  const sendTicket = async () => {
    if (!ticketInput.trim() || sending) return;
    setSending(true);
    try {
      const res = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: ticketInput }),
      });
      const data = await res.json();
      if (data.ticketId) {
        setTicketId(data.ticketId);
        setView('ticket-sent');
        setTicketInput('');
      }
    } catch {}
    setSending(false);
  };

  const fmtTime = (d) => new Date(d).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });

  if (!user) return null;

  return (
    <div className="chat-widget">
      {isOpen && (
        <div className="chat-panel">
          <div className="chat-header">
            <div>
              <h3>CFanalisis Soporte</h3>
              <span className="chat-online">En linea</span>
            </div>
            <button className="chat-close" onClick={() => { setIsOpen(false); setView('menu'); }}>&times;</button>
          </div>

          {/* MENU */}
          {view === 'menu' && (
            <div className="chat-menu">
              <p style={{ color: 'var(--t2)', fontSize: '.85rem', marginBottom: '8px' }}>
                Hola {user?.name?.split(' ')[0] || 'Usuario'}! Como podemos ayudarte?
              </p>
              <button className="chat-menu-btn" onClick={() => setView('ticket')}>
                <span className="chat-menu-icon">&#127758;</span>
                <span>No aparece tu liga</span>
              </button>
              <button className="chat-menu-btn" onClick={() => setView('chat')}>
                <span className="chat-menu-icon">&#128172;</span>
                <span>Hablar con un agente</span>
              </button>
            </div>
          )}

          {/* TICKET INPUT */}
          {view === 'ticket' && (
            <div className="chat-ticket-input">
              <button className="chat-menu-btn" onClick={() => setView('menu')} style={{ padding: '8px 12px', fontSize: '.8rem' }}>
                &#9664; Volver
              </button>
              <p style={{ color: 'var(--t2)', fontSize: '.85rem' }}>
                Describe la liga que necesitas y la agregaremos lo antes posible.
              </p>
              <textarea
                value={ticketInput}
                onChange={(e) => setTicketInput(e.target.value)}
                placeholder="Ej: Liga de Suecia - Allsvenskan..."
                rows={3}
              />
              <button className="chat-ticket-btn" onClick={sendTicket} disabled={sending || !ticketInput.trim()}>
                {sending ? 'Enviando...' : 'Enviar solicitud'}
              </button>
            </div>
          )}

          {/* TICKET SENT */}
          {view === 'ticket-sent' && (
            <div className="chat-menu" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', marginBottom: '12px' }}>&#9989;</div>
              <p style={{ color: 'var(--green)', fontWeight: 700, fontSize: '1rem', marginBottom: '8px' }}>
                Ticket creado: {ticketId}
              </p>
              <p style={{ color: 'var(--t2)', fontSize: '.85rem', marginBottom: '16px' }}>
                Tu ticket {ticketId} sera procesado en maximo 12 horas.
              </p>
              <button className="chat-menu-btn" onClick={() => setView('menu')}>Volver al menu</button>
            </div>
          )}

          {/* LIVE CHAT */}
          {view === 'chat' && (
            <>
              <div className="chat-messages">
                {messages.length === 0 && (
                  <div className="chat-msg system">
                    Escribe tu mensaje y te responderemos lo antes posible.
                  </div>
                )}
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
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                  placeholder="Escribe un mensaje..."
                />
                <button className="chat-send" onClick={sendMessage} disabled={sending || !input.trim()}>
                  Enviar
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <button className="chat-trigger" onClick={() => setIsOpen(!isOpen)}>
        {isOpen ? '\u2715' : '\uD83D\uDCAC'}
        {unread > 0 && !isOpen && <span className="chat-unread">{unread}</span>}
      </button>
    </div>
  );
}
