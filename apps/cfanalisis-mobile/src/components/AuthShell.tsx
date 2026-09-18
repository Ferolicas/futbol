import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { ShieldCheck } from 'lucide-react-native';
import { AppText, Screen } from '@/components/ui';
import { assetUrl } from '@/lib/config';
import { colors, radius } from '@/theme/tokens';

interface Props { eyebrow: string; title: string; subtitle: string; children: React.ReactNode; footer?: React.ReactNode }

/** Carcasa compartida de registro, login y recuperación. */
export function AuthShell({ eyebrow, title, subtitle, children, footer }: Props) {
  return (
    <Screen edges={['top', 'bottom']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.glowOne} pointerEvents="none" />
          <View style={styles.panel}>
            <View style={styles.logoRow}>
              <Image source={{ uri: assetUrl('/cf-icon-192.png') || undefined }} style={styles.logo} contentFit="cover" />
              <AppText variant="heading" size={17}>CF Análisis</AppText>
            </View>
            <AppText variant="kicker" tone="accent">{eyebrow}</AppText>
            <AppText variant="title" size={26}>{title}</AppText>
            <AppText tone="muted">{subtitle}</AppText>
            <View style={{ gap: 14, marginTop: 8 }}>{children}</View>
            {footer}
            <View style={styles.privacy}>
              <ShieldCheck size={13} color={colors.muted} />
              <AppText variant="caption" tone="muted">Conexión segura y datos protegidos</AppText>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 20 },
  glowOne: { position: 'absolute', top: -80, right: -60, width: 260, height: 260, borderRadius: 130, backgroundColor: 'rgba(94,230,177,0.10)' },
  panel: { gap: 10, padding: 22, borderRadius: 22, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceStrong },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  logo: { width: 38, height: 38, borderRadius: radius.md },
  privacy: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center', marginTop: 8 },
});
