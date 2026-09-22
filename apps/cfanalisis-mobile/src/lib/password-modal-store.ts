// Pub-sub minimo para abrir el modal de "Cambiar contraseña" desde cualquier
// pantalla (menú de cuenta, o el enlace que da el asistente de IA) sin pasar
// parámetros entre rutas de expo-router.
type Listener = (visible: boolean) => void;
const listeners = new Set<Listener>();
let visible = false;

export function openPasswordModal() {
  visible = true;
  listeners.forEach((listener) => listener(visible));
}

export function closePasswordModal() {
  visible = false;
  listeners.forEach((listener) => listener(visible));
}

export function subscribePasswordModal(listener: Listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getPasswordModalVisible() {
  return visible;
}
