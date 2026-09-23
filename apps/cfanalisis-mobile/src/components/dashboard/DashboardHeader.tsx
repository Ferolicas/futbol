import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronDown, KeyRound, LogOut, MessageCircle, Search, Sparkles } from 'lucide-react-native';
import { AppText } from '@/components/ui';
import { UpgradeButton } from '@/components/analysis/FreeAccess';
import { useAuth } from '@/lib/auth-context';
import { useAccess } from '@/lib/access-context';
import { assetUrl } from '@/lib/config';
import { openPasswordModal } from '@/lib/password-modal-store';
import { colors, radius } from '@/theme/tokens';

/** Header autenticado: avatar con menú (chat, planes, salir), logo centrado y búsqueda. */
export function DashboardHeader() {
  const { user, signOut } = useAuth();
  const { isFree } = useAccess();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const fullName = user?.name || user?.email?.split('@')[0] || 'Usuario';
  const firstName = fullName.trim().split(/\s+/)[0] || 'Usuario';
  const initial = firstName.charAt(0).toLocaleUpperCase('es-ES');

  const logout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try { await signOut(); } finally { setMenuOpen(false); setLoggingOut(false); router.replace('/sign-in'); }
  };

  return (
    <View style={[styles.bar, { paddingTop: insets.top + 6 }]}>
      <Pressable onPress={() => setMenuOpen(true)} style={styles.account} accessibilityRole="button" accessibilityLabel={`Abrir menú de ${firstName}`}>
        <View style={styles.avatar}><AppText variant="label" weight="bold" style={{ color: colors.onAccent }}>{initial}</AppText></View>
        <AppText variant="label" numberOfLines={1} style={{ maxWidth: 70 }}>{firstName}</AppText>
        <ChevronDown size={14} color={colors.muted} />
      </Pressable>

      {/* Mismo logo que la cabecera del dashboard web (BrandLogoMedia,
          animated=false ahí también): el isotipo completo, sin ícono+texto
          por separado. */}
      <View style={styles.brand}>
        <Image source={{ uri: assetUrl('/logo-metalizado-alpha-fast.webp') || undefined }} style={styles.logo} contentFit="contain" accessibilityLabel="CF Análisis" />
      </View>

      <View style={styles.actions}>
        <Pressable onPress={() => router.push('/search')} style={styles.iconBtn} accessibilityLabel="Buscar en todos los deportes">
          <Search size={18} color={colors.text} />
        </Pressable>
        <UpgradeButton />
      </View>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setMenuOpen(false)} />
        <View style={[styles.menu, { top: insets.top + 54 }]}>
          <View style={styles.menuHead}>
            <AppText variant="label" weight="bold" numberOfLines={1}>{fullName}</AppText>
            <AppText variant="caption" tone="muted" numberOfLines={1}>{user?.email}</AppText>
            <AppText variant="caption" tone={isFree ? 'muted' : 'accent'}>{isFree ? 'Acceso gratis' : 'Acceso Pro activo'}</AppText>
          </View>
          <Pressable style={styles.menuItem} onPress={() => { setMenuOpen(false); router.push('/assistant'); }}>
            <Sparkles size={17} color={colors.accent} />
            <AppText variant="label">Preguntar</AppText>
          </Pressable>
          <Pressable style={styles.menuItem} onPress={() => { setMenuOpen(false); router.push('/chat'); }}>
            <MessageCircle size={17} color={colors.accent} />
            <AppText variant="label">Chat y soporte</AppText>
          </Pressable>
          <Pressable style={styles.menuItem} onPress={() => { setMenuOpen(false); openPasswordModal(); }}>
            <KeyRound size={17} color={colors.accent} />
            <AppText variant="label">Cambiar contraseña</AppText>
          </Pressable>
          {isFree && (
            <Pressable style={styles.menuItem} onPress={() => { setMenuOpen(false); router.push('/plans'); }}>
              <Sparkles size={17} color={colors.accent} />
              <AppText variant="label">Planes Pro</AppText>
            </Pressable>
          )}
          <Pressable style={styles.menuItem} onPress={logout} disabled={loggingOut}>
            <LogOut size={17} color={colors.error} />
            <AppText variant="label" tone="error">{loggingOut ? 'Cerrando sesión…' : 'Cerrar sesión'}</AppText>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingBottom: 8, backgroundColor: colors.surfaceStrong, borderBottomWidth: 1, borderBottomColor: colors.border },
  account: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, paddingRight: 6, borderRadius: radius.pill },
  avatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  brand: { position: 'absolute', left: 0, right: 0, bottom: 10, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, pointerEvents: 'none' },
  logo: { width: 128, height: 128 * (288 / 512) },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: colors.border },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  menu: { position: 'absolute', left: 12, width: 250, padding: 8, borderRadius: radius.lg, backgroundColor: colors.surfaceSolid, borderWidth: 1, borderColor: colors.borderStrong, gap: 2 },
  menuHead: { padding: 10, gap: 2, borderBottomWidth: 1, borderBottomColor: colors.border, marginBottom: 4 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 10, borderRadius: radius.md },
});
