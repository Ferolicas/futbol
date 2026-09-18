import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ArrowLeft, CircleCheck, Globe, Headphones, MessageCircle, Send, X } from 'lucide-react-native';
import { AppText, Banner, Button, Card, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useWorkerEvent } from '@/lib/realtime/hooks';
import { colors, fonts, radius } from '@/theme/tokens';

interface Message { id: string; message: string; sender: 'user' | 'agent' | string; read?: boolean; created_at: string }

/** Centro de ayuda: chat con soporte (realtime chat-<userId>) y solicitud de liga (tickets). */
export default function ChatScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [view, setView] = useState<'menu' | 'chat' | 'ticket' | 'ticket-sent'>('menu');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [ticketInput, setTicketInput] = useState('');
  const [ticketId, setTicketId] = useState('');
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState('');
  const listRef = useRef<FlatList>(null);
  const firstName = (user?.name || user?.email?.split('@')[0] || 'Usuario').trim().split(/\s+/)[0];

  const loadMessages = useCallback(async () => {
    try {
      const data = await api.get<{ messages?: Message[] }>('/api/chat');
      if (Array.isArray(data.messages)) {
        setMessages(data.messages);
        const unread = data.messages.filter((m) => m.sender === 'agent' && !m.read).map((m) => m.id);
        if (unread.length) api.patch('/api/chat', { messageIds: unread.slice(0, 100) }).catch(() => {});
      }
    } catch {}
  }, []);

  useWorkerEvent(user?.id ? `chat-${user.id}` : null, 'new-message', useCallback((message: any) => {
    setMessages((previous) => previous.some((entry) => entry.id === message.id) ? previous : [...previous, { id: message.id, message: message.message, sender: message.sender, created_at: message.created_at }]);
  }, []));

  useEffect(() => {
    if (view !== 'chat') return;
    loadMessages();
    const poll = setInterval(loadMessages, 30_000);
    return () => clearInterval(poll);
  }, [view, loadMessages]);

  useEffect(() => { if (messages.length) setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60); }, [messages.length]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true); setFeedback(''); setInput('');
    setMessages((previous) => [...previous, { id: `temp-${Date.now()}`, message: text, sender: 'user', created_at: new Date().toISOString() }]);
    try { await api.post('/api/chat', { message: text }); await loadMessages(); }
    catch (cause: any) { setFeedback(cause?.message || 'No se pudo enviar el mensaje.'); }
    finally { setSending(false); }
  };

  const sendTicket = async () => {
    const text = ticketInput.trim();
    if (!text || sending) return;
    setSending(true); setFeedback('');
    try {
      const data = await api.post<{ ticketId?: string }>('/api/tickets', { message: text });
      if (!data.ticketId) throw new Error('No se pudo crear la solicitud.');
      setTicketId(data.ticketId); setView('ticket-sent'); setTicketInput('');
    } catch (cause: any) { setFeedback(cause?.message || 'No se pudo crear la solicitud.'); }
    finally { setSending(false); }
  };

  const fmtTime = (date: string) => { try { return new Date(date).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

  return (
    <Screen edges={['top', 'bottom']}>
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
          {view !== 'menu' && <Pressable onPress={() => { setView('menu'); setFeedback(''); }} hitSlop={8}><ArrowLeft size={20} color={colors.text} /></Pressable>}
          <View style={styles.mark}><Headphones size={20} color={colors.accent} /></View>
          <View><AppText variant="label" weight="bold">CF Análisis</AppText><AppText variant="caption" tone="accent">● Soporte en línea</AppText></View>
        </View>
        <Pressable onPress={() => router.back()} style={styles.close} accessibilityLabel="Cerrar"><X size={18} color={colors.text} /></Pressable>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        {view === 'menu' && (
          <View style={{ padding: 16, gap: 14 }}>
            <AppText variant="kicker" tone="accent">Centro de ayuda</AppText>
            <AppText variant="title">Hola, {firstName}</AppText>
            <AppText tone="muted">¿Qué necesitas resolver hoy?</AppText>
            <Pressable onPress={() => { setView('ticket'); setFeedback(''); }}><Card style={{ gap: 6 }}><Globe size={24} color={colors.accent} /><AppText variant="heading">No aparece tu liga</AppText><AppText variant="caption" tone="muted">Solicita una competición y nuestro equipo la revisará.</AppText></Card></Pressable>
            <Pressable onPress={() => { setView('chat'); setFeedback(''); }}><Card style={{ gap: 6 }}><MessageCircle size={24} color={colors.accent} /><AppText variant="heading">Hablar con un agente</AppText><AppText variant="caption" tone="muted">Abre una conversación directa con soporte.</AppText></Card></Pressable>
          </View>
        )}

        {view === 'ticket' && (
          <View style={{ padding: 16, gap: 12 }}>
            <Globe size={26} color={colors.accent} />
            <AppText variant="title">Solicitar una liga</AppText>
            <AppText tone="muted">Indica el país, la competición y cualquier detalle que nos ayude a identificarla.</AppText>
            <TextInput value={ticketInput} onChangeText={setTicketInput} placeholder="Ej.: Suecia — Allsvenskan" placeholderTextColor={colors.faint} multiline numberOfLines={6} maxLength={1200} style={[styles.input, { minHeight: 140, textAlignVertical: 'top' }]} />
            {feedback ? <Banner tone="error" message={feedback} /> : null}
            <Button title={sending ? 'Enviando…' : 'Enviar solicitud'} loading={sending} disabled={!ticketInput.trim()} onPress={sendTicket} icon={<Send size={16} color={colors.onAccent} />} />
          </View>
        )}

        {view === 'ticket-sent' && (
          <View style={{ padding: 24, alignItems: 'center', gap: 10 }}>
            <CircleCheck size={40} color={colors.accent} />
            <AppText variant="title">Solicitud recibida</AppText>
            <AppText variant="mono" tone="accent">{ticketId}</AppText>
            <AppText tone="muted" align="center">La revisaremos en un plazo máximo de 12 horas.</AppText>
            <Button title="Volver al inicio" variant="secondary" onPress={() => setView('menu')} />
          </View>
        )}

        {view === 'chat' && (
          <View style={{ flex: 1 }}>
            <FlatList
              ref={listRef}
              data={messages}
              keyExtractor={(item) => item.id}
              contentContainerStyle={{ padding: 16, gap: 8 }}
              ListEmptyComponent={<AppText tone="muted" align="center">Escribe tu mensaje y te responderemos lo antes posible.</AppText>}
              renderItem={({ item }) => (
                <View style={[styles.bubble, item.sender === 'user' ? styles.bubbleUser : styles.bubbleAgent]}>
                  <AppText>{item.message}</AppText>
                  <AppText variant="caption" tone="faint" align="right">{fmtTime(item.created_at)}</AppText>
                </View>
              )}
            />
            {feedback ? <View style={{ paddingHorizontal: 16 }}><Banner tone="error" message={feedback} /></View> : null}
            <View style={styles.inputBar}>
              <TextInput value={input} onChangeText={setInput} placeholder="Escribe un mensaje…" placeholderTextColor={colors.faint} maxLength={2000} style={[styles.input, { flex: 1 }]} onSubmitEditing={sendMessage} returnKeyType="send" />
              <Pressable onPress={sendMessage} disabled={sending || !input.trim()} style={[styles.send, (!input.trim() || sending) && { opacity: 0.5 }]} accessibilityLabel="Enviar mensaje"><Send size={18} color={colors.onAccent} /></Pressable>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  mark: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
  close: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: colors.border },
  input: { color: colors.text, fontFamily: fonts.sans, fontSize: 15, padding: 12, borderRadius: radius.md, backgroundColor: colors.surfaceSolid, borderWidth: 1, borderColor: colors.borderStrong },
  inputBar: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: colors.border },
  send: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent },
  bubble: { maxWidth: '84%', padding: 10, borderRadius: radius.lg, gap: 2 },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentBorder },
  bubbleAgent: { alignSelf: 'flex-start', backgroundColor: colors.surfaceSolid, borderWidth: 1, borderColor: colors.border },
});
