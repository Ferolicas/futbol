export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;
export const PASSWORD_INPUT_MAX_LENGTH = 256;

export function validateNewPassword(value) {
  if (typeof value !== 'string') {
    return { success: false, error: 'La contraseña es obligatoria.' };
  }
  if (value.length < PASSWORD_MIN_LENGTH) {
    return { success: false, error: `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.` };
  }
  if (value.length > PASSWORD_INPUT_MAX_LENGTH || Buffer.byteLength(value, 'utf8') > PASSWORD_MAX_BYTES) {
    return { success: false, error: 'La contraseña no puede superar 72 bytes.' };
  }
  return { success: true, password: value };
}
