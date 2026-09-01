'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowLeft,
  CheckCircle2,
  Globe2,
  Headphones,
  MessageCircle,
  Minimize2,
  Send,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../components/providers';
import { usePusherEvent } from '../../lib/use-pusher';

function animationState(origin, reduceMotion) {
  if (reduceMotion) return { opacity: 0 };
  return {
    opacity: 0,
    x: origin.x,
    y: origin.y,
    scaleX: .055,
    scaleY: .035,
    borderRadius: '999px',
    clipPath: 'polygon(47% 0, 53% 0, 52% 100%, 48% 100%)',
    filter: 'blur(3px)',
  };
}

export default function ChatWidget() {
  const { user } = useAuth();
  const reduceMotion = useReducedMotion();
  const triggerRef = useRef(null);
  const messagesEndRef = useRef(null);
  const pollRef = useRef(null);
  const openRef = useRef(false);
  const [mounted, setMounted] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const [view, setView] = useState('menu');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [ticketInput, setTicketInput] = useState('');
  const [ticketId, setTicketId] = useState('');
  const [sending, setSending] = useState(false);
  const [unread, setUnread] = useState(0);
  const [feedback, setFeedback] = useState('');

  openRef.current = isOpen;
  useEffect(() => setMounted(true), []);

  const loadMessages = useCallback(async () => {
    try {
      const response = await fetch('/api/chat');
      const data = await response.json();
      if (Array.isArray(data.messages)) {
        setMessages(data.messages);
        const pending = data.messages.filter((message) => message.sender === 'agent' && !message.read).length;
        setUnread(openRef.current ? 0 : pending);
      }
    } catch {}
  }, []);

  usePusherEvent(
    user?.id ? `chat-${user.id}` : null,
    'new-message',
    useCallback((message) => {
      setMessages((previous) => {
        if (previous.some((entry) => entry._id === message._id)) return previous;
        return [...previous, message];
      });
      if (message.sender === 'agent' && !openRef.current) setUnread((previous) => previous + 1);
    }, []),
  );

  useEffect(() => {
    if (isOpen && view === 'chat' && user) {
      setUnread(0);
      loadMessages();
      pollRef.current = window.setInterval(loadMessages, 30_000);
      return () => window.clearInterval(pollRef.current);
    }
    if (pollRef.current) window.clearInterval(pollRef.current);
    return undefined;
  }, [isOpen, loadMessages, user, view]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [messages, reduceMotion]);

  const closeChat = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setOrigin({
        x: rect.left + rect.width / 2 - window.innerWidth / 2,
        y: rect.top + rect.height / 2 - window.innerHeight / 2,
      });
    }
    setIsOpen(false);
  }, []);

  const openChat = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setOrigin({
        x: rect.left + rect.width / 2 - window.innerWidth / 2,
        y: rect.top + rect.height / 2 - window.innerHeight / 2,
      });
    }
    setFeedback('');
    setIsOpen(true);
  };

  useEffect(() => {
    if (!isOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onEscape = (event) => {
      if (event.key === 'Escape') closeChat();
    };
    document.addEventListener('keydown', onEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onEscape);
    };
  }, [closeChat, isOpen]);

  const sendMessage = async (event) => {
    event?.preventDefault();
    if (!input.trim() || sending) return;
    setSending(true);
    setFeedback('');
    const text = input.trim();
    setInput('');
    setMessages((previous) => [...previous, {
      _id: `temp-${Date.now()}`,
      message: text,
      sender: 'user',
      createdAt: new Date().toISOString(),
    }]);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      if (!response.ok) throw new Error('No se pudo enviar el mensaje.');
      await loadMessages();
    } catch (error) {
      setFeedback(error.message || 'No se pudo enviar el mensaje.');
    } finally {
      setSending(false);
    }
  };

  const sendTicket = async (event) => {
    event?.preventDefault();
    if (!ticketInput.trim() || sending) return;
    setSending(true);
    setFeedback('');
    try {
      const response = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: ticketInput.trim() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ticketId) throw new Error(data.error || 'No se pudo crear la solicitud.');
      setTicketId(data.ticketId);
      setView('ticket-sent');
      setTicketInput('');
    } catch (error) {
      setFeedback(error.message || 'No se pudo crear la solicitud.');
    } finally {
      setSending(false);
    }
  };

  const fmtTime = (date) => new Date(date).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const firstName = user?.name?.split(' ')[0] || user?.displayName?.split(' ')[0] || 'Usuario';

  if (!user) return null;

  const panel = (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="chat-fullscreen"
          role="dialog"
          aria-modal="true"
          aria-label="Chat y soporte de CF Análisis"
          initial={animationState(origin, reduceMotion)}
          animate={reduceMotion ? { opacity: 1 } : {
            opacity: 1,
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            borderRadius: '0px',
            clipPath: [
              'polygon(47% 0, 53% 0, 52% 100%, 48% 100%)',
              'polygon(8% 0, 92% 0, 68% 100%, 32% 100%)',
              'inset(0% 0% 0% 0% round 0px)',
            ],
            filter: 'blur(0px)',
          }}
          exit={reduceMotion ? { opacity: 0 } : {
            opacity: [1, .96, 0],
            x: [0, origin.x * .48, origin.x],
            y: [0, origin.y * .42, origin.y],
            scaleX: [1, .48, .055],
            scaleY: [1, .72, .035],
            borderRadius: ['0px', '0 0 44% 44%', '999px'],
            clipPath: [
              'inset(0% 0% 0% 0% round 0px)',
              'polygon(5% 0, 95% 0, 61% 100%, 39% 100%)',
              'polygon(47% 0, 53% 0, 52% 100%, 48% 100%)',
            ],
            filter: ['blur(0px)', 'blur(1px)', 'blur(3px)'],
          }}
          transition={{ duration: reduceMotion ? 0 : .48, times: [0, .58, 1], ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="chat-fullscreen-shell">
            <header className="chat-fullscreen-header">
              <div className="chat-header-leading">
                {view !== 'menu' && (
                  <button type="button" className="chat-back" onClick={() => { setView('menu'); setFeedback(''); }} aria-label="Volver al menú de soporte">
                    <ArrowLeft size={20} aria-hidden="true" />
                  </button>
                )}
                <span className="chat-support-mark"><Headphones size={22} aria-hidden="true" /></span>
                <span>
                  <strong>CF Análisis</strong>
                  <small><i aria-hidden="true" /> Soporte en línea</small>
                </span>
              </div>
              <button type="button" className="chat-minimize" onClick={closeChat} aria-label="Minimizar chat">
                <Minimize2 size={20} aria-hidden="true" />
                <span>Minimizar</span>
              </button>
            </header>

            <main className={`chat-fullscreen-content is-${view}`}>
              {view === 'menu' && (
                <section className="chat-home">
                  <span className="chat-home-kicker">Centro de ayuda</span>
                  <h1>Hola, {firstName}</h1>
                  <p>¿Qué necesitas resolver hoy?</p>
                  <div className="chat-home-actions">
                    <button type="button" onClick={() => { setView('ticket'); setFeedback(''); }}>
                      <span><Globe2 size={25} aria-hidden="true" /></span>
                      <strong>No aparece tu liga</strong>
                      <small>Solicita una competición y nuestro equipo la revisará.</small>
                    </button>
                    <button type="button" onClick={() => { setView('chat'); setFeedback(''); }}>
                      <span><MessageCircle size={25} aria-hidden="true" /></span>
                      <strong>Hablar con un agente</strong>
                      <small>Abre una conversación directa con soporte.</small>
                    </button>
                  </div>
                </section>
              )}

              {view === 'ticket' && (
                <form className="chat-ticket-form" onSubmit={sendTicket}>
                  <span className="chat-section-icon"><Globe2 size={25} aria-hidden="true" /></span>
                  <h1>Solicitar una liga</h1>
                  <p>Indica el país, la competición y cualquier detalle que nos ayude a identificarla.</p>
                  <label>
                    <span>Descripción</span>
                    <textarea
                      value={ticketInput}
                      onChange={(event) => setTicketInput(event.target.value)}
                      placeholder="Ej.: Suecia — Allsvenskan"
                      rows={6}
                      maxLength={1200}
                      autoFocus
                    />
                  </label>
                  {feedback && <div className="chat-feedback is-error" role="alert">{feedback}</div>}
                  <button type="submit" className="chat-primary-action" disabled={sending || !ticketInput.trim()}>
                    {sending ? 'Enviando…' : 'Enviar solicitud'}
                    <Send size={17} aria-hidden="true" />
                  </button>
                </form>
              )}

              {view === 'ticket-sent' && (
                <section className="chat-ticket-success">
                  <span><CheckCircle2 size={36} aria-hidden="true" /></span>
                  <h1>Solicitud recibida</h1>
                  <strong>{ticketId}</strong>
                  <p>La revisaremos en un plazo máximo de 12 horas.</p>
                  <button type="button" className="chat-primary-action" onClick={() => setView('menu')}>Volver al inicio</button>
                </section>
              )}

              {view === 'chat' && (
                <section className="chat-conversation">
                  <div className="chat-messages" aria-live="polite">
                    {messages.length === 0 && (
                      <div className="chat-msg system">Escribe tu mensaje y te responderemos lo antes posible.</div>
                    )}
                    {messages.map((message) => (
                      <div key={message._id} className={`chat-msg ${message.sender}`}>
                        <div>{message.message}</div>
                        <div className="chat-msg-time">{fmtTime(message.createdAt)}</div>
                      </div>
                    ))}
                    <div ref={messagesEndRef} />
                  </div>
                  {feedback && <div className="chat-feedback is-error" role="alert">{feedback}</div>}
                  <form className="chat-input-bar" onSubmit={sendMessage}>
                    <input
                      className="chat-input"
                      value={input}
                      onChange={(event) => setInput(event.target.value)}
                      placeholder="Escribe un mensaje…"
                      maxLength={2000}
                      autoFocus
                    />
                    <button className="chat-send" type="submit" disabled={sending || !input.trim()} aria-label="Enviar mensaje">
                      <Send size={19} aria-hidden="true" />
                      <span>Enviar</span>
                    </button>
                  </form>
                </section>
              )}
            </main>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="dashboard-chat-trigger"
        onClick={openChat}
        aria-label="Abrir chat y soporte"
        aria-expanded={isOpen}
      >
        <MessageCircle size={20} aria-hidden="true" />
        <span>Chat</span>
        {unread > 0 && <b>{unread > 9 ? '9+' : unread}</b>}
      </button>
      {mounted ? createPortal(panel, document.body) : null}
    </>
  );
}
