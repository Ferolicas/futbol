// Sistema visual de CF Análisis (docs/DESIGN.md): oscuro, azul petróleo casi
// negro, acento verde menta. El ámbar queda solo para advertencias.
export const colors = {
  bg: '#03090f',
  surface: 'rgba(10,22,29,0.82)',
  surfaceStrong: 'rgba(13,29,37,0.96)',
  surfaceSolid: '#0b1720',
  surfaceRaised: '#10231f',
  text: '#edf6f4',
  textSecondary: '#c4d2d4',
  muted: '#8fa1aa',
  faint: '#5f707a',
  accent: '#5ee6b1',
  accentSoft: 'rgba(94,230,177,0.14)',
  accentBorder: 'rgba(94,230,177,0.32)',
  border: 'rgba(255,255,255,0.085)',
  borderStrong: 'rgba(255,255,255,0.16)',
  error: '#fb7185',
  errorSoft: 'rgba(251,113,133,0.14)',
  warning: '#fbbf24',
  warningSoft: 'rgba(251,191,36,0.14)',
  live: '#ef4444',
  cyan: '#22d3ee',
  amber: '#f5e400',
  onAccent: '#03221a',
  white: '#ffffff',
} as const;

export const fonts = {
  sans: 'PlusJakartaSans_500Medium',
  sansSemibold: 'PlusJakartaSans_600SemiBold',
  sansBold: 'PlusJakartaSans_700Bold',
  sansExtra: 'PlusJakartaSans_800ExtraBold',
  mono: 'JetBrainsMono_600SemiBold',
  monoBold: 'JetBrainsMono_700Bold',
} as const;

export const radius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 } as const;
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
