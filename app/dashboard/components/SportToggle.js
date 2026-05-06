'use client';

import { usePathname, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';

/**
 * Sport toggle: switches between fútbol (/dashboard) and baseball (/dashboard/baseball).
 * Renders as a sticky pill at the top of the dashboard.
 */
export default function SportToggle() {
  const pathname = usePathname();
  const router = useRouter();

  const isBaseball = pathname?.startsWith('/dashboard/baseball');
  const sport = isBaseball ? 'baseball' : 'futbol';

  const goTo = (target) => {
    if (target === sport) return;
    if (target === 'baseball') router.push('/dashboard/baseball');
    else router.push('/dashboard');
  };

  const styles = {
    wrap: {
      display: 'flex',
      gap: 6,
      padding: 4,
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: 999,
      width: 'fit-content',
      margin: '0 auto 16px',
    },
    btn: (active, color) => ({
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '8px 18px',
      borderRadius: 999,
      cursor: 'pointer',
      border: 'none',
      background: active
        ? `linear-gradient(135deg, ${color}, ${color}cc)`
        : 'transparent',
      color: active ? '#06060b' : '#cbd5e1',
      fontWeight: 700,
      fontSize: '.9rem',
      letterSpacing: '.3px',
      transition: 'all .25s ease',
      boxShadow: active ? `0 4px 14px ${color}55` : 'none',
    }),
    icon: { fontSize: '1rem', lineHeight: 1 },
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      style={styles.wrap}
      role="tablist"
      aria-label="Cambiar deporte"
    >
      <button
        type="button"
        role="tab"
        aria-selected={!isBaseball}
        onClick={() => goTo('futbol')}
        style={styles.btn(!isBaseball, '#10b981')}
      >
        <span style={styles.icon}>⚽</span>
        Fútbol
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={isBaseball}
        onClick={() => goTo('baseball')}
        style={styles.btn(isBaseball, '#f59e0b')}
      >
        <span style={styles.icon}>⚾</span>
        Baseball
      </button>
    </motion.div>
  );
}
