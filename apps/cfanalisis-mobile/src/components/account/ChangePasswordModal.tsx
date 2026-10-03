import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { CheckCircle2, KeyRound, Mail, X } from 'lucide-react-native';
import { AppText, Banner, Button } from '@/components/ui';
import { api } from '@/lib/api';
import { closePasswordModal, getPasswordModalVisible, subscribePasswordModal } from '@/lib/password-modal-store';
import { colors, radius } from '@/theme/tokens';

/** Solicita un enlace de un solo uso al correo registrado. La contraseña nunca
 * se cambia directamente desde una sesión que pudiera haber sido secuestrada. */
export function ChangePasswordModal() {
  const [visible, setVisible] = useState(getPasswordModalVisible());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => subscribePasswordModal(setVisible), []);
  useEffect(() => {
    if (!visible) return;
    setError(''); setSuccess(false);
  }, [visible]);

  const submit = async () => {
    if (saving) return;
    setSaving(true); setError('');
    try {
      await api.post('/api/auth/change-password');
      setSuccess(true);
    } catch (cause: any) {
      setError(cause?.message || 'No se pudo cambiar la contraseña.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={closePasswordModal}>
      <Pressable style={styles.backdrop} onPress={closePasswordModal} />
      <View style={styles.center} pointerEvents="box-none">
        <View style={styles.dialog}>
          <Pressable style={styles.close} onPress={closePasswordModal} disabled={saving} accessibilityLabel="Cerrar">
            <X size={18} color={colors.text} />
          </Pressable>
          <View style={styles.icon}><KeyRound size={22} color={colors.accent} /></View>
          <AppText variant="title" size={19}>Restablecer contraseña</AppText>
          {success ? (
            <View style={{ marginTop: 14, gap: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <CheckCircle2 size={18} color={colors.accent} />
                <AppText tone="accent">Enlace enviado al correo de tu cuenta.</AppText>
              </View>
              <Button title="Listo" onPress={closePasswordModal} />
            </View>
          ) : (
            <View style={{ marginTop: 14, gap: 12 }}>
              <View style={styles.notice}>
                <Mail size={18} color={colors.accent} />
                <AppText tone="muted" style={{ flex: 1 }}>
                  Te enviaremos un enlace seguro al correo registrado. Allí crearás y confirmarás la nueva contraseña.
                </AppText>
              </View>
              {error ? <Banner tone="error" message={error} /> : null}
              <Button title={saving ? 'Enviando…' : 'Enviar enlace seguro'} loading={saving} onPress={submit} />
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(2,10,18,0.85)' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 18 },
  dialog: { width: '100%', maxWidth: 420, padding: 22, borderRadius: radius.lg, backgroundColor: colors.surfaceSolid, borderWidth: 1, borderColor: colors.borderStrong },
  close: { position: 'absolute', right: 12, top: 12, padding: 8 },
  icon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft, marginBottom: 10 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surfaceStrong },
});
