'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { MessageCircle, Send, X } from 'lucide-react';

// Renderiza [texto](url) como enlace clicable — el asistente los usa para
// ofrecer el análisis completo de un partido o una acción del dashboard
// (ej. cambiar contraseña) sin poder ejecutarla él mismo.
const LINK_RE = /\[([^\]]+)\]\((\/[^)\s]+)\)/g;
function renderWithLinks(text) {
  const parts = [];
  let last = 0, match, key = 0;
  LINK_RE.lastIndex = 0;
  while ((match = LINK_RE.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(<Link key={key++} href={match[2]} className="match-assistant-link">{match[1]}</Link>);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : text;
}

async function askAssistant(messages) {
  const response = await fetch('/api/assistant/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'No se pudo consultar al asistente');
  return data.answer;
}
export default function MatchAssistant() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState([{ role: 'assistant', content: 'Pregúntame por cualquier partido o pronóstico que exista en CF Análisis.' }]);
  const end = useRef(null);

  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);
  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return undefined;
    const controller = new AbortController();
    context.registerTool({
      name: 'cf_ask_about_match',
      title: 'Consultar CF Análisis',
      description: 'Consulta en lenguaje natural partidos y pronósticos que ya existen en CF Análisis. Es solo lectura y nunca ejecuta el motor.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { question: { type: 'string', minLength: 1, maxLength: 3000 } }, required: ['question'] },
      annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: false },
      async execute({ question }) {
        const answer = await askAssistant([{ role: 'user', content: question }]);
        return { content: [{ type: 'text', text: answer }] };
      },
    }, { signal: controller.signal }).catch(() => {});
    return () => controller.abort();
  }, []);

  const submit = async (event) => {
    event?.preventDefault();
    const question = input.trim();
    if (!question || busy) return;
    const history = [...messages.filter((message) => message.role !== 'error'), { role: 'user', content: question }].slice(-15);
    setMessages(history); setInput(''); setBusy(true);
    try { setMessages([...history, { role: 'assistant', content: await askAssistant(history) }]); }
    catch (error) { setMessages([...history, { role: 'error', content: error.message }]); }
    finally { setBusy(false); }
  };

  return <>
    <button type="button" className="match-assistant-launcher" onClick={() => setOpen(true)} aria-label="Abrir asistente de partidos"><MessageCircle size={22} /><span>Preguntar</span></button>
    {open && <section className="match-assistant" role="dialog" aria-modal="false" aria-label="Asistente de CF Análisis">
      <header><span><small>Solo consulta datos existentes</small><strong>Asistente CF</strong></span><button type="button" onClick={() => setOpen(false)} aria-label="Cerrar"><X size={18} /></button></header>
      <div className="match-assistant-messages">
        {messages.map((message, index) => <div key={index} className={`match-assistant-message is-${message.role}`}>{renderWithLinks(message.content)}</div>)}
        {busy && <div className="match-assistant-message is-assistant">Consultando datos guardados…</div>}
        <span ref={end} />
      </div>
      <form onSubmit={submit} toolname="cf_ask_about_match_form" tooldescription="Consulta un partido o pronóstico existente en CF Análisis">
        <input value={input} onChange={(event) => setInput(event.target.value)} maxLength={3000} placeholder="Ej. ¿Qué pronóstico hay para…?" toolparamdescription="Pregunta sobre un partido o pronóstico" />
        <button type="submit" disabled={busy || !input.trim()} aria-label="Enviar"><Send size={17} /></button>
      </form>
      <p>Las probabilidades son estimaciones, no garantías.</p>
    </section>}
  </>;
}
