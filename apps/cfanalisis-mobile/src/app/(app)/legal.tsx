import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ArrowLeft, ExternalLink, Mail, ShieldCheck } from 'lucide-react-native';
import { AppText, Banner, Button, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { LEGAL_DOCUMENTS, LEGAL_DOCUMENT_VERSION, openLegalDocument } from '@/lib/legal';
import { colors, radius } from '@/theme/tokens';

export default function LegalScreen() {
  const router = useRouter();
  const [marketing, setMarketing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const preference = await api.get<{ enabled: boolean }>('/api/legal/marketing');
      setMarketing(preference.enabled === true);
    } catch (cause: any) {
      setError(cause?.message || 'No pudimos consultar tu preferencia.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const preference = await api.post<{ enabled: boolean }>('/api/legal/marketing', { enabled: marketing, source: 'mobile' });
      setMarketing(preference.enabled === true);
      setMessage(preference.enabled
        ? 'Aceptaste recibir descuentos y novedades.'
        : 'Ya no recibirás comunicaciones promocionales.');
    } catch (cause: any) {
      setError(cause?.message || 'No pudimos guardar tu preferencia.');
    } finally { setSaving(false); }
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable style={styles.back} onPress={() => router.back()} accessibilityLabel="Volver">
          <ArrowLeft size={20} color={colors.text} />
        </Pressable>
        <AppText variant="heading">Legal y comunicaciones</AppText>
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.card}>
          <View style={styles.titleRow}><ShieldCheck size={20} color={colors.accent} /><AppText variant="title" size={19}>Documentos vigentes</AppText></View>
          <AppText tone="muted">Aplican a CF Análisis en la web, Android y iPhone. Versión {LEGAL_DOCUMENT_VERSION}.</AppText>
          {LEGAL_DOCUMENTS.map((document) => (
            <Pressable key={document.key} style={styles.document} onPress={() => openLegalDocument(document.url)}>
              <AppText tone="accent" weight="bold" style={{ flex: 1 }}>{document.label}</AppText>
              <ExternalLink size={16} color={colors.accent} />
            </Pressable>
          ))}
        </View>

        <View style={styles.card}>
          <AppText variant="title" size={19}>Comunicaciones promocionales</AppText>
          <AppText tone="muted">Decide si quieres recibir descuentos, lanzamientos y novedades de CF Análisis. Es opcional y puedes retirarlo aquí.</AppText>
          <View style={styles.preference}>
            <View style={{ flex: 1, gap: 3 }}>
              <AppText weight="bold">Marketing por correo</AppText>
              <AppText variant="caption" tone="muted">Solo se envía desde info@cfanalisis.com.</AppText>
            </View>
            <Switch
              value={marketing}
              onValueChange={setMarketing}
              disabled={loading || saving}
              trackColor={{ false: colors.borderStrong, true: colors.accentBorder }}
              thumbColor={marketing ? colors.accent : colors.muted}
            />
          </View>
          <AppText variant="caption" tone="muted">Los correos necesarios para seguridad, pagos y funcionamiento de la cuenta no son publicidad.</AppText>
          {error ? <Banner tone="error" message={error} /> : null}
          {message ? <Banner tone="success" message={message} /> : null}
          <Button title={saving ? 'Guardando…' : 'Guardar preferencia'} loading={saving || loading} onPress={save} />
        </View>

        <View style={styles.contact}>
          <Mail size={16} color={colors.muted} />
          <AppText variant="caption" tone="muted">Privacidad y soporte: info@cfanalisis.com</AppText>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { minHeight: 56, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surfaceStrong },
  back: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.05)' },
  content: { padding: 16, gap: 14, paddingBottom: 32 },
  card: { gap: 14, padding: 18, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceStrong },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  document: { minHeight: 48, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surfaceSolid },
  preference: { paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 14 },
  contact: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 8 },
});
