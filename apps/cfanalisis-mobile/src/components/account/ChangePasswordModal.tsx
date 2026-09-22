import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { CheckCircle2, Eye, EyeOff, KeyRound, X } from 'lucide-react-native';
import { AppText, Banner, Button } from '@/components/ui';
import { api } from '@/lib/api';
import { closePasswordModal, getPasswordModalVisible, subscribePasswordModal } from '@/lib/password-modal-store';
import { colors, radius } from '@/theme/tokens';

/** Mismo endpoint que el modal web (/api/auth/change-password): sesión activa,
 * solo pide la nueva contraseña y su confirmación. */
export function ChangePasswordModal() {
  const [visible, setVisible] = useState(getPasswordModalVisible());
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => subscribePasswordModal(setVisible), []);
  useEffect(() => {
    if (!visible) return;
    setNewPassword(''); setConfirmPassword(''); setError(''); setSuccess(false); setReveal(false);
  }, [visible]);

  const submit = async () => {
    if (saving) return;
    if (newPassword !== confirmPassword) { setError('Las contraseñas no coinciden'); return; }
    if (newPassword.length < 8) { setError('La contraseña debe tener al menos 8 caracteres'); return; }
    setSaving(true); setError('');
    try {
      await api.post('/api/auth/change-password', { newPassword, confirmPassword });
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
          <AppText variant="title" size={19}>Cambiar contraseña</AppText>
          {success ? (
            <View style={{ marginTop: 14, gap: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <CheckCircle2 size={18} color={colors.accent} />
                <AppText tone="accent">Contraseña actualizada.</AppText>
              </View>
              <Button title="Listo" onPress={closePasswordModal} />
            </View>
          ) : (
            <View style={{ marginTop: 14, gap: 12 }}>
              <View>
                <AppText variant="caption" tone="muted" style={{ marginBottom: 6 }}>Nueva contraseña</AppText>
                <View style={styles.field}>
                  <TextInput
                    value={newPassword}
                    onChangeText={setNewPassword}
                    secureTextEntry={!reveal}
                    placeholder="Mínimo 8 caracteres"
                    placeholderTextColor={colors.faint}
                    style={styles.input}
                    autoCapitalize="none"
                  />
                  <Pressable onPress={() => setReveal((v) => !v)} style={styles.reveal} hitSlop={8}>
                    {reveal ? <EyeOff size={17} color={colors.muted} /> : <Eye size={17} color={colors.muted} />}
                  </Pressable>
                </View>
              </View>
              <View>
                <AppText variant="caption" tone="muted" style={{ marginBottom: 6 }}>Confirmar contraseña</AppText>
                <TextInput
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  secureTextEntry={!reveal}
                  placeholder="Repite la contraseña"
                  placeholderTextColor={colors.faint}
                  style={[styles.input, { paddingRight: 12 }]}
                  autoCapitalize="none"
                />
              </View>
              {error ? <Banner tone="error" message={error} /> : null}
              <Button title={saving ? 'Guardando…' : 'Guardar contraseña'} loading={saving} onPress={submit} disabled={!newPassword || !confirmPassword} />
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
  field: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surfaceStrong },
  input: { flex: 1, color: colors.text, fontSize: 15, paddingVertical: 11, paddingHorizontal: 13 },
  reveal: { padding: 10 },
});
