import { useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { CheckSquare2, Square } from 'lucide-react-native';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { AppText, Banner, Button } from '@/components/ui';
import { colors } from '@/theme/tokens';
import { LEGAL_DOCUMENTS, openLegalDocument } from '@/lib/legal';

export function LegalAcceptanceGate() {
  const { user, refreshSession, signOut } = useAuth();
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [legalConfirmed, setLegalConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  if (!user?.legalAcceptanceRequired) return null;

  const accept = async () => {
    setLoading(true);
    setError('');
    try {
      await api.post('/api/legal/accept', {
        acceptAll: true,
        marketingConsent,
        version: user.legalDocumentVersion,
        source: 'mobile',
      });
      await refreshSession();
    } catch (cause: any) {
      setError(cause?.message || 'No pudimos guardar la aceptación.');
    } finally { setLoading(false); }
  };

  return (
    <Modal visible animationType="fade" statusBarTranslucent>
      <View style={{ flex: 1, justifyContent: 'center', padding: 20, backgroundColor: colors.bg }}>
        <View style={{ gap: 16, padding: 22, borderRadius: 20, backgroundColor: colors.surfaceSolid }}>
          <AppText variant="title">Documentos legales</AppText>
          <AppText tone="muted">Para continuar, confirma que eres mayor de 18 años y acepta los Términos, Privacidad y Cookies.</AppText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
            {LEGAL_DOCUMENTS.map((document) => (
              <Pressable key={document.key} onPress={() => openLegalDocument(document.url)}>
                <AppText tone="accent" weight="bold">{document.label}</AppText>
              </Pressable>
            ))}
          </View>
          <Pressable onPress={() => setLegalConfirmed((value) => !value)} style={{ flexDirection: 'row', gap: 10 }}>
            {legalConfirmed ? <CheckSquare2 size={20} color={colors.accent} /> : <Square size={20} color={colors.muted} />}
            <AppText tone="muted" style={{ flex: 1 }}>Soy mayor de 18 años, acepto los documentos obligatorios y autorizo el tratamiento descrito.</AppText>
          </Pressable>
          <Pressable onPress={() => setMarketingConsent((value) => !value)} style={{ flexDirection: 'row', gap: 10 }}>
            {marketingConsent ? <CheckSquare2 size={20} color={colors.accent} /> : <Square size={20} color={colors.muted} />}
            <AppText tone="muted" style={{ flex: 1 }}>Quiero recibir descuentos y novedades. Es opcional.</AppText>
          </Pressable>
          {error ? <Banner tone="error" message={error} /> : null}
          <Button title={loading ? 'Guardando…' : 'Aceptar todo y continuar'} loading={loading} disabled={!legalConfirmed} onPress={accept} />
          <Button title="No aceptar y cerrar sesión" variant="ghost" onPress={signOut} />
        </View>
      </View>
    </Modal>
  );
}
