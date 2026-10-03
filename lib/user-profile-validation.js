export const DISPLAY_NAME_MIN_LENGTH = 2;
export const DISPLAY_NAME_MAX_LENGTH = 60;
export const DISPLAY_NAME_MAX_WORDS = 6;

const NAME_PATTERN = /^[\p{L}\p{M}]+(?:[ .’'-][\p{L}\p{M}]+)*\.?$/u;
const BLOCKED_WORDS = new Set([
  'admin', 'administrador', 'administrator', 'cfanalisis', 'soporte', 'support',
  'owner', 'propietario', 'puta', 'puto', 'mierda', 'fuck',
]);

export function normalizeDisplayName(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function validateDisplayName(value) {
  const name = normalizeDisplayName(value);
  if (name.length < DISPLAY_NAME_MIN_LENGTH) {
    return { success: false, name, error: 'Escribe un nombre de al menos 2 caracteres.' };
  }
  if (name.length > DISPLAY_NAME_MAX_LENGTH) {
    return { success: false, name, error: 'El nombre no puede superar 60 caracteres.' };
  }
  if (name.split(' ').length > DISPLAY_NAME_MAX_WORDS) {
    return { success: false, name, error: 'El nombre no puede superar 6 palabras.' };
  }
  if (!NAME_PATTERN.test(name)) {
    return { success: false, name, error: 'Usa solo letras, espacios, puntos, apóstrofes o guiones.' };
  }
  const words = name.toLocaleLowerCase('es').split(/[ .’'-]+/u);
  if (words.some((word) => BLOCKED_WORDS.has(word))) {
    return { success: false, name, error: 'Ese nombre no está permitido.' };
  }
  return { success: true, name, error: null };
}
