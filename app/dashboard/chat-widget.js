'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Eye,
  EyeOff,
  Globe2,
  Headphones,
  KeyRound,
  LogOut,
  MessageCircle,
  Minimize2,
  Send,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../components/providers';
import { usePusherEvent } from '../../lib/use-pusher';
import AndroidIcon from '../../components/AndroidIcon';
import { ANDROID_APK_URL } from '../../lib/app-download';

export default function ChatWidget() {
  const { user, supabase } = useAuth();
  const reduceMotion = useReducedMotion();
  const accountRef = useRef(null);
  const triggerRef = useRef(null);
  const messagesEndRef = useRef(null);
  const pollRef = useRef(null);
  const openRef = useRef(false);
  const accountMenuId = useId();
  const [mounted, setMounted] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [origin, setOrigin] = useState({ x: 24, y: 24 });
  const [view, setView] = useState('menu');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [ticketInput, setTicketInput] = useState('');
  const [ticketId, setTicketId] = useState('');
  const [sending, setSending] = useState(false);
  const [unread, setUnread] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [pwdModalOpen, setPwdModalOpen] = useState(false);
  const [pwdNew, setPwdNew] = useState('');
  const [pwdConfirm, setPwdConfirm] = useState('');
  const [pwdSaving, setPwdSaving] = useState(false);
  const [pwdError, setPwdError] = useState('');
  const [pwdSuccess, setPwdSuccess] = useState(false);
  const [pwdReveal, setPwdReveal] = useState(false);
  const pwdDialogRef = useRef(null);

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
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
    }
    setIsOpen(false);
  }, []);

  const openChat = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setOrigin({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
    }
    setAccountOpen(false);
    setFeedback('');
    setIsOpen(true);
  };

  useEffect(() => {
    if (!accountOpen) return undefined;

    const focusFrame = window.requestAnimationFrame(() => {
      accountRef.current?.querySelector('[role="menuitem"]')?.focus();
    });
    const closeOnOutside = (event) => {
      if (!accountRef.current?.contains(event.target)) setAccountOpen(false);
    };
    const handleKeys = (event) => {
      if (event.key === 'Escape') {
        setAccountOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = [...(accountRef.current?.querySelectorAll('[role="menuitem"]') || [])];
      if (!items.length) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement);
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1) % items.length
            : (current <= 0 ? items.length : current) - 1;
      items[next]?.focus();
    };

    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', handleKeys);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', handleKeys);
    };
  }, [accountOpen]);

  const signOut = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await supabase?.auth.signOut();
    } finally {
      window.location.assign('/');
    }
  };

  const openPasswordModal = () => {
    setAccountOpen(false);
    setPwdNew('');
    setPwdConfirm('');
    setPwdError('');
    setPwdSuccess(false);
    setPwdReveal(false);
    setPwdModalOpen(true);
  };

  // El asistente de chat ("Preguntar") no puede cambiar la contraseña — no
  // ejecuta acciones, solo consulta. Pero sí puede señalar este enlace
  // (?action=change-password) para abrir el modal real que ya existe acá.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') !== 'change-password') return;
    openPasswordModal();
    params.delete('action');
    const query = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''));
  }, []);

  const closePasswordModal = useCallback(() => {
    if (pwdSaving) return;
    setPwdModalOpen(false);
  }, [pwdSaving]);

  useEffect(() => {
    if (!pwdModalOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => {
      pwdDialogRef.current?.querySelector('input')?.focus();
    });
    const onEscape = (event) => {
      if (event.key === 'Escape') closePasswordModal();
    };
    document.addEventListener('keydown', onEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onEscape);
    };
  }, [pwdModalOpen, closePasswordModal]);

  const submitPasswordChange = async (event) => {
    event.preventDefault();
    if (pwdSaving) return;
    setPwdError('');

    if (!pwdNew || !pwdConfirm) {
      setPwdError('Completa todos los campos');
      return;
    }
    if (pwdNew !== pwdConfirm) {
      setPwdError('Las contraseñas no coinciden');
      return;
    }
    if (pwdNew.length < 8) {
      setPwdError('La contraseña debe tener al menos 8 caracteres');
      return;
    }

    setPwdSaving(true);
    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: pwdNew, confirmPassword: pwdConfirm }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'No se pudo cambiar la contraseña.');
      setPwdSuccess(true);
      setPwdNew('');
      setPwdConfirm('');
    } catch (error) {
      setPwdError(error.message || 'No se pudo cambiar la contraseña.');
    } finally {
      setPwdSaving(false);
    }
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
  const fullName = user?.name || user?.displayName || user?.email?.split('@')[0] || 'Usuario';
  const firstName = fullName.trim().split(/\s+/)[0] || 'Usuario';
  const initial = firstName.charAt(0).toLocaleUpperCase('es-ES');

  if (!user) return null;

  const panel = (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="chat-fullscreen"
          role="dialog"
          aria-modal="true"
          aria-label="Chat y soporte de CF Análisis"
          initial={false}
          animate={{ opacity: 1, clipPath: 'inset(0% 0% 0% 0% round 0px)' }}
          exit={reduceMotion ? { opacity: 0 } : {
            opacity: [1, 1, 0],
            clipPath: [
              'inset(0% 0% 0% 0% round 0px)',
              `polygon(0 0, 100% 0, ${Math.min(100, Math.max(0, (origin.x / (typeof window === 'undefined' ? 1 : window.innerWidth)) * 100 + 8))}% 100%, ${Math.min(100, Math.max(0, (origin.x / (typeof window === 'undefined' ? 1 : window.innerWidth)) * 100 - 8))}% 100%)`,
              `circle(0px at ${origin.x}px ${origin.y}px)`,
            ],
          }}
          transition={{ duration: reduceMotion ? 0 : .4, times: [0, .64, 1], ease: [0.32, 0.72, 0, 1] }}
        >
          <motion.div
            className="chat-fullscreen-shell"
            initial={reduceMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduceMotion ? 0 : .18, ease: [0.22, 1, 0.36, 1] }}
          >
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
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <>
      <div className="dashboard-account dashboard-account-chat" ref={accountRef}>
        <button
          ref={triggerRef}
          type="button"
          className={`dashboard-account-trigger ${accountOpen ? 'is-open' : ''}`}
          onClick={() => setAccountOpen((open) => !open)}
          aria-label={`Abrir menú de ${firstName}`}
          aria-controls={accountMenuId}
          aria-expanded={accountOpen}
          aria-haspopup="menu"
        >
          <span className="dashboard-avatar" aria-hidden="true">{initial}</span>
          <span className="dashboard-account-name">{firstName}</span>
          <ChevronDown size={15} aria-hidden="true" />
          {unread > 0 && <b className="dashboard-account-unread">{unread > 9 ? '9+' : unread}</b>}
        </button>

        {accountOpen && (
          <div id={accountMenuId} className="dashboard-account-menu" role="menu" aria-label="Menú de cuenta">
            <button type="button" className="dashboard-account-action is-chat" onClick={openChat} role="menuitem">
              <MessageCircle size={17} aria-hidden="true" />
              <span>Chat</span>
              {unread > 0 && <small>{unread > 9 ? '9+' : unread} sin leer</small>}
            </button>
            <a className="dashboard-account-action is-install" href={ANDROID_APK_URL} download rel="noopener" role="menuitem" onClick={() => setAccountOpen(false)}>
              <AndroidIcon size={17} />
              <span>Instalar app</span>
              <small>Android</small>
            </a>
            <button type="button" className="dashboard-account-action is-password" onClick={openPasswordModal} role="menuitem">
              <KeyRound size={17} aria-hidden="true" />
              <span>Cambiar contraseña</span>
            </button>
            <button type="button" className="dashboard-account-action is-logout" onClick={signOut} disabled={loggingOut} role="menuitem">
              <LogOut size={17} aria-hidden="true" />
              <span>{loggingOut ? 'Cerrando sesión…' : 'Cerrar sesión'}</span>
            </button>
          </div>
        )}
      </div>
      {mounted ? createPortal(panel, document.body) : null}
      {mounted && pwdModalOpen ? createPortal(
        <div className="password-modal-overlay" onClick={(event) => { if (event.target === event.currentTarget) closePasswordModal(); }}>
          <section
            className="password-modal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="password-modal-title"
            tabIndex={-1}
            ref={pwdDialogRef}
          >
            <button type="button" className="password-modal-close" onClick={closePasswordModal} aria-label="Cerrar" disabled={pwdSaving}>
              <ArrowLeft size={18} aria-hidden="true" style={{ transform: 'rotate(45deg)' }} />
            </button>
            <span className="password-modal-icon"><KeyRound size={22} aria-hidden="true" /></span>
            <h2 id="password-modal-title">Cambiar contraseña</h2>

            {pwdSuccess ? (
              <>
                <p className="password-modal-success">
                  <CheckCircle2 size={18} aria-hidden="true" /> Contraseña actualizada correctamente.
                </p>
                <button type="button" className="chat-primary-action" onClick={closePasswordModal}>Listo</button>
              </>
            ) : (
              <form onSubmit={submitPasswordChange}>
                <label>
                  <span>Nueva contraseña</span>
                  <span className="password-modal-field">
                    <input
                      type={pwdReveal ? 'text' : 'password'}
                      value={pwdNew}
                      onChange={(event) => setPwdNew(event.target.value)}
                      autoComplete="new-password"
                      minLength={8}
                      required
                    />
                    <button
                      type="button"
                      className="password-modal-reveal"
                      onClick={() => setPwdReveal((reveal) => !reveal)}
                      aria-label={pwdReveal ? 'Ocultar contraseñas' : 'Mostrar contraseñas'}
                      aria-pressed={pwdReveal}
                    >
                      {pwdReveal ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                    </button>
                  </span>
                </label>
                <label>
                  <span>Confirmar nueva contraseña</span>
                  <span className="password-modal-field">
                    <input
                      type={pwdReveal ? 'text' : 'password'}
                      value={pwdConfirm}
                      onChange={(event) => setPwdConfirm(event.target.value)}
                      autoComplete="new-password"
                      minLength={8}
                      required
                    />
                    <button
                      type="button"
                      className="password-modal-reveal"
                      onClick={() => setPwdReveal((reveal) => !reveal)}
                      aria-label={pwdReveal ? 'Ocultar contraseñas' : 'Mostrar contraseñas'}
                      aria-pressed={pwdReveal}
                    >
                      {pwdReveal ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                    </button>
                  </span>
                  {pwdConfirm && (
                    pwdNew === pwdConfirm ? (
                      <small className="password-modal-match is-ok"><CheckCircle2 size={13} aria-hidden="true" /> Las contraseñas coinciden</small>
                    ) : (
                      <small className="password-modal-match is-bad"><XCircle size={13} aria-hidden="true" /> Las contraseñas no coinciden</small>
                    )
                  )}
                </label>
                {pwdError && <div className="chat-feedback is-error" role="alert">{pwdError}</div>}
                <button type="submit" className="chat-primary-action" disabled={pwdSaving}>
                  {pwdSaving ? 'Guardando…' : 'Guardar contraseña'}
                </button>
              </form>
            )}
          </section>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
