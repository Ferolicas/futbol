import { useCallback, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Send, Sparkles, X } from 'lucide-react-native';
import { AppText, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { openPasswordModal } from '@/lib/password-modal-store';
import { colors, fonts, radius } from '@/theme/tokens';

interface ChatMessage { role: 'user' | 'assistant' | 'error'; content: string }

const SPORT_PATH_RE: Array<[RegExp, string]> = [
  [/^\/dashboard\/baseball\/analisis\/(\d+)/, 'baseball'],
  [/^\/dashboard\/baloncesto\/analisis\/(\d+)/, 'basketball'],
  [/^\/dashboard\/futbol-americano\/analisis\/(\d+)/, 'american_football'],
  [/^\/dashboard\/analisis\/(\d+)/, 'football'],
];

const LINK_RE = /\[([^\]]+)\]\((\/[^)\s]+)\)/g;

/** Asistente de IA (equivalente móvil de "Preguntar" en la web): mismo
 * endpoint /api/assistant/chat, solo lectura. Los enlaces que devuelve
 * (análisis completo de un partido, o una acción del dashboard como cambiar
 * contraseña) se convierten en navegación/acción nativa. */
export default function AssistantScreen() {
  const router = useRouter();
  const listRef = useRef<FlatList>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: 'Pregúntame por cualquier partido o pronóstico que exista en CF Análisis.' },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const scrollToEnd = useCallback(() => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
  }, []);

  // El asistente es una pantalla modal: cualquier acción de un enlace se
  // ejecuta DESPUÉS de cerrarla. Antes el modal de contraseña se abría detrás
  // (invisible) y al cerrar "Preguntar" quedaba encima bloqueando los toques.
  const closeThen = (action: () => void) => {
    if (router.canGoBack()) router.back();
    setTimeout(action, 450);
  };

  const handleLink = (url: string) => {
    for (const [re, sport] of SPORT_PATH_RE) {
      const match = url.match(re);
      if (match) { closeThen(() => router.push({ pathname: '/match/[sport]/[id]', params: { sport, id: match[1] } })); return; }
    }
    if (url.includes('action=change-password')) { closeThen(openPasswordModal); return; }
  };

  const submit = async () => {
    const question = input.trim();
    if (!question || busy) return;
    const history = [...messages.filter((m) => m.role !== 'error'), { role: 'user' as const, content: question }].slice(-15);
    setMessages(history); setInput(''); setBusy(true); scrollToEnd();
    try {
      const data = await api.post<{ answer?: string; error?: string }>('/api/assistant/chat', { messages: history });
      if (!data.answer) throw new Error(data.error || 'No se pudo consultar al asistente');
      setMessages([...history, { role: 'assistant', content: data.answer }]);
    } catch (cause: any) {
      setMessages([...history, { role: 'error', content: cause?.message || 'No se pudo consultar al asistente' }]);
    } finally {
      setBusy(false); scrollToEnd();
    }
  };

  const renderMessage = ({ item }: { item: ChatMessage }) => {
    const parts: React.ReactNode[] = [];
    let last = 0, match: RegExpExecArray | null, key = 0;
    LINK_RE.lastIndex = 0;
    while ((match = LINK_RE.exec(item.content))) {
      if (match.index > last) parts.push(item.content.slice(last, match.index));
      const url = match[2];
      parts.push(
        <Text key={key++} style={styles.link} onPress={() => handleLink(url)}>{match[1]}</Text>,
      );
      last = match.index + match[0].length;
    }
    if (last < item.content.length) parts.push(item.content.slice(last));
    return (
      <View style={[styles.bubble, item.role === 'user' ? styles.bubbleUser : item.role === 'error' ? styles.bubbleError : styles.bubbleAgent]}>
        <Text style={[styles.bubbleText, item.role === 'user' && { color: colors.bg }]}>{parts.length ? parts : item.content}</Text>
      </View>
    );
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
          <View style={styles.mark}><Sparkles size={20} color={colors.accent} /></View>
          <View>
            <AppText variant="label" weight="bold">Asistente CF</AppText>
            <AppText variant="caption" tone="muted">Solo consulta datos existentes</AppText>
          </View>
        </View>
        <Pressable onPress={() => router.back()} style={styles.close} accessibilityLabel="Cerrar"><X size={18} color={colors.text} /></Pressable>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(_, index) => String(index)}
          contentContainerStyle={{ padding: 16, gap: 8 }}
          renderItem={renderMessage}
          ListFooterComponent={busy ? <View style={[styles.bubble, styles.bubbleAgent]}><Text style={styles.bubbleText}>Consultando datos guardados…</Text></View> : null}
        />
        <View style={styles.inputBar}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Ej. ¿Qué pronóstico hay para…?"
            placeholderTextColor={colors.faint}
            maxLength={3000}
            style={[styles.input, { flex: 1 }]}
            onSubmitEditing={submit}
            returnKeyType="send"
          />
          <Pressable onPress={submit} disabled={busy || !input.trim()} style={[styles.send, (!input.trim() || busy) && { opacity: 0.5 }]} accessibilityLabel="Enviar">
            <Send size={18} color={colors.onAccent} />
          </Pressable>
        </View>
        <AppText variant="caption" tone="faint" align="center" style={{ paddingBottom: 10 }}>Las probabilidades son estimaciones, no garantías.</AppText>
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
  bubble: { maxWidth: '86%', padding: 10, borderRadius: radius.lg },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: colors.accent },
  bubbleAgent: { alignSelf: 'flex-start', backgroundColor: colors.surfaceSolid, borderWidth: 1, borderColor: colors.border },
  bubbleError: { alignSelf: 'flex-start', backgroundColor: colors.errorSoft, borderWidth: 1, borderColor: 'rgba(251,113,133,0.35)' },
  bubbleText: { color: colors.text, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19 },
  link: { color: colors.accent, fontWeight: '700', textDecorationLine: 'underline' },
});
