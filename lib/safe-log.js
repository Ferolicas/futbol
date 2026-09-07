// Convierte datos no confiables en una sola línea acotada antes de enviarlos a
// logs de texto. Evita que CR/LF o controles fabriquen entradas falsas.
export function safeLogValue(value, maxLength = 500) {
  const raw = value instanceof Error ? value.message : String(value ?? '');
  return raw
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .slice(0, maxLength);
}

export function safeLogFields(fields) {
  const safe = {};
  for (const [key, value] of Object.entries(fields || {})) {
    safe[key] = typeof value === 'number' || typeof value === 'boolean'
      ? value
      : safeLogValue(value);
  }
  return JSON.stringify(safe);
}
