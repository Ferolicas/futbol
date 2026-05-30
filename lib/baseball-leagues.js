// Baseball leagues — MLB-only tras la migración a MLB Stats API.
//
// Antes este módulo mantenía IDs de api-sports.io para múltiples ligas (NPB,
// KBO, LMB, ligas de invierno caribeñas). Esa integración se purgó cuando el
// backend pasó a usar MLB Stats API (gratuita, oficial) como fuente única para
// MLB. El frontend sigue importando `BASEBALL_FLAGS` para renderizar emojis
// junto al país de cada liga / división, así que se conserva ese export.

export const BASEBALL_FLAGS = {
  USA: '🇺🇸',
  Japan: '🇯🇵',
  'South Korea': '🇰🇷',
  Taiwan: '🇹🇼',
  Mexico: '🇲🇽',
  'Dominican Rep': '🇩🇴',
  Venezuela: '🇻🇪',
  'Puerto Rico': '🇵🇷',
  Australia: '🇦🇺',
  World: '🌍',
};
